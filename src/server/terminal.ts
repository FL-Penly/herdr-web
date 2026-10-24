import type { ServerWebSocket } from 'bun'
import { logInput } from '../herdr.ts'

// Bridges an xterm.js socket to `herdr terminal session observe|control`, which speaks NDJSON:
// it prints `terminal.frame` ({bytes: base64, width, height, full}) / `terminal.closed` records and reads
// `terminal.input|resize|scroll|mouse|release` commands.
//
// Server → browser: binary frames (raw terminal bytes) plus JSON {type: 'mode'|'size'|'closed'|'ended'|'stderr'}.
// Browser → server: JSON {type: 'control'|'observe'|'input'|'resize'|'scroll'|'mouse'}.

export interface TermData {
  kind: 'term'
  pane: string
  cols: number
  rows: number
  mode?: 'observe' | 'control'
  /** The mode the socket opens in: control shows the pane at the browser's size from the start. */
  opening?: 'observe' | 'control'
  generation: number
  proc?: TermProcess
  /** Frames were dropped because the socket was backed up; restart the session for a full redraw. */
  stalled?: boolean
}

export interface TermProcess {
  stdin: { write(chunk: string): unknown; flush(): unknown }
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  kill(): void
}

export type TermSocket = Pick<
  ServerWebSocket<TermData>,
  'data' | 'readyState' | 'send' | 'sendBinary' | 'getBufferedAmount'
>

export type TermMessage =
  | { type: 'control'; cols?: number; rows?: number; takeover: boolean }
  | { type: 'observe'; cols?: number; rows?: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'scroll'; direction: 'up' | 'down'; lines: number }
  | { type: 'mouse'; action: 'down' | 'up'; button: MouseButton; column: number; row: number }

type MouseButton = 'left' | 'right' | 'middle'
const MOUSE_BUTTONS: readonly MouseButton[] = ['left', 'right', 'middle']

const SIZE = { minCols: 20, maxCols: 400, minRows: 5, maxRows: 200, cols: 120, rows: 40 }
const HIGH_WATER = 4 << 20
const LOW_WATER = 256 << 10
const MAX_LINE = 16 << 20
const MAX_INPUT = 1 << 20
const SCROLL_LOG_MS = 2_000
const lastScrollLog = new WeakMap<object, number>()
const RELEASE_GRACE_MS = 200

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(n)))
/** A 0-based cell index, or null. */
const cellIndex = (v: unknown, size: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < size ? v : null
const finite = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

/** A terminal size within herdr's sane bounds; missing or bogus values fall back to `fallback`. */
export function clampSize(
  cols: unknown,
  rows: unknown,
  fallback: { cols: number; rows: number } = SIZE,
): { cols: number; rows: number } {
  return {
    cols: clamp(finite(cols) ?? fallback.cols, SIZE.minCols, SIZE.maxCols),
    rows: clamp(finite(rows) ?? fallback.rows, SIZE.minRows, SIZE.maxRows),
  }
}

export function parseTermMessage(raw: string | Buffer): TermMessage | null {
  let msg: unknown
  try {
    msg = JSON.parse(String(raw))
  } catch {
    return null
  }
  if (typeof msg !== 'object' || msg === null) return null
  const m = msg as Record<string, unknown>
  const size = () => ({ cols: finite(m.cols) ?? undefined, rows: finite(m.rows) ?? undefined })
  switch (m.type) {
    case 'control':
      return { type: 'control', ...size(), takeover: m.takeover === true }
    case 'observe':
      return { type: 'observe', ...size() }
    case 'input':
      return typeof m.data === 'string' && m.data.length <= MAX_INPUT ? { type: 'input', data: m.data } : null
    case 'resize': {
      const cols = finite(m.cols)
      const rows = finite(m.rows)
      return cols && rows ? { type: 'resize', cols, rows } : null
    }
    case 'scroll':
      return {
        type: 'scroll',
        direction: m.direction === 'down' ? 'down' : 'up',
        lines: clamp(finite(m.lines) ?? 1, 1, 50),
      }
    case 'mouse': {
      const column = cellIndex(m.column, SIZE.maxCols)
      const row = cellIndex(m.row, SIZE.maxRows)
      const button = MOUSE_BUTTONS.find(b => b === m.button)
      if ((m.action !== 'down' && m.action !== 'up') || !button || column === null || row === null) return null
      return { type: 'mouse', action: m.action, button, column, row }
    }
    default:
      return null
  }
}

type SpawnSession = (args: string[]) => TermProcess

export class TerminalBridge {
  private sockets = new Set<TermSocket>()

  constructor(
    private spawn: SpawnSession,
    /** Keys typed into a pane, which may answer the dialog on screen. */
    private onInput: (pane: string) => void = () => {},
  ) {}

  open(ws: TermSocket): void {
    this.sockets.add(ws)
    this.start(ws, ws.data.opening ?? 'observe')
  }

  message(ws: TermSocket, raw: string | Buffer): void {
    const msg = parseTermMessage(raw)
    if (!msg) return
    const d = ws.data
    switch (msg.type) {
      case 'control':
        if (d.mode !== 'control' || msg.takeover) {
          Object.assign(d, clampSize(msg.cols, msg.rows, d))
          this.start(ws, 'control', msg.takeover)
        }
        break
      case 'observe':
        if (d.mode !== 'observe') {
          Object.assign(d, clampSize(msg.cols, msg.rows, d))
          this.start(ws, 'observe')
        }
        break
      case 'input':
        if (d.mode === 'control') {
          this.write(ws, { type: 'terminal.input', bytes: Buffer.from(msg.data, 'utf8').toString('base64') })
          this.onInput(d.pane)
        }
        break
      case 'resize':
        Object.assign(d, clampSize(msg.cols, msg.rows, d))
        if (d.mode === 'control') this.write(ws, { type: 'terminal.resize', cols: d.cols, rows: d.rows })
        break
      case 'scroll':
        if (d.mode === 'control') {
          this.write(ws, { type: 'terminal.scroll', direction: msg.direction, lines: msg.lines })
          // One line per burst of wheel events.
          const now = Date.now()
          if (now - (lastScrollLog.get(ws) ?? 0) > SCROLL_LOG_MS) logInput(d.pane, `terminal scroll ${msg.direction}`)
          lastScrollLog.set(ws, now)
        }
        break
      case 'mouse':
        // herdr hands a click to the program only if it asked for the mouse, encoded the way it asked.
        if (d.mode === 'control') {
          this.write(ws, {
            type: 'terminal.mouse',
            action: msg.action,
            button: msg.button,
            column: msg.column,
            row: msg.row,
          })
          if (msg.action === 'down') this.onInput(d.pane)
        }
        break
    }
  }

  /** The socket drained after backpressure: if frames were dropped, restart for a full redraw. */
  drain(ws: TermSocket): void {
    if (ws.data.stalled && ws.getBufferedAmount() < LOW_WATER) this.redraw(ws)
  }

  close(ws: TermSocket): void {
    this.sockets.delete(ws)
    ws.data.generation++
    this.stop(ws)
  }

  closeAll(): void {
    for (const ws of [...this.sockets]) this.close(ws)
  }

  private redraw(ws: TermSocket): void {
    ws.data.stalled = false
    const mode = ws.data.mode ?? 'observe'
    // We held control a moment ago; take it back without waiting for the release to land.
    this.start(ws, mode, mode === 'control')
  }

  private start(ws: TermSocket, mode: 'observe' | 'control', takeover = false): void {
    this.stop(ws)
    const gen = ++ws.data.generation
    const { pane, cols, rows } = ws.data
    const args = ['terminal', 'session', mode, pane, '--cols', String(cols), '--rows', String(rows)]
    if (mode === 'control' && takeover) args.push('--takeover')
    // Control resizes the pane to the browser's terminal.
    if (mode === 'control') logInput(pane, `terminal control ${cols}x${rows}${takeover ? ' (takeover)' : ''}`)
    let proc: TermProcess
    try {
      proc = this.spawn(args)
    } catch (err) {
      send(ws, { type: 'stderr', text: err instanceof Error ? err.message : String(err) })
      send(ws, { type: 'ended', sawFrame: false })
      return
    }
    ws.data.proc = proc
    ws.data.mode = mode
    send(ws, { type: 'mode', mode })
    void this.pump(ws, proc, gen)
    void this.drainStderr(ws, proc, gen)
  }

  private stop(ws: TermSocket): void {
    const proc = ws.data.proc
    ws.data.proc = undefined
    if (!proc) return
    try {
      proc.stdin.write(`${JSON.stringify({ type: 'terminal.release' })}\n`)
      proc.stdin.flush()
    } catch {}
    setTimeout(() => proc.kill(), RELEASE_GRACE_MS)
  }

  private write(ws: TermSocket, cmd: object): void {
    const proc = ws.data.proc
    if (!proc) return
    try {
      proc.stdin.write(`${JSON.stringify(cmd)}\n`)
      proc.stdin.flush()
    } catch {}
  }

  private async pump(ws: TermSocket, proc: TermProcess, gen: number): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ''
    let sawFrame = false
    try {
      for await (const chunk of proc.stdout) {
        if (ws.data.generation !== gen) return
        buf += decoder.decode(chunk, { stream: true })
        if (buf.length > MAX_LINE && !buf.includes('\n')) buf = ''
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line) sawFrame = this.record(ws, line, sawFrame)
          if (ws.data.generation !== gen) return
        }
      }
    } catch {}
    if (ws.data.generation === gen) send(ws, { type: 'ended', sawFrame })
  }

  /** Handle one NDJSON record; returns whether a frame has been seen. */
  private record(ws: TermSocket, line: string, sawFrame: boolean): boolean {
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      return sawFrame
    }
    if (rec?.type === 'terminal.closed') {
      send(ws, { type: 'closed', reason: typeof rec.reason === 'string' ? rec.reason : '' })
      return sawFrame
    }
    if (rec?.type !== 'terminal.frame' || typeof rec.bytes !== 'string') return sawFrame
    if (ws.data.stalled) {
      if (ws.getBufferedAmount() < LOW_WATER) this.redraw(ws)
      return true
    }
    if (ws.getBufferedAmount() > HIGH_WATER) {
      ws.data.stalled = true
      return true
    }
    if (!sawFrame || rec.full) send(ws, { type: 'size', cols: rec.width, rows: rec.height, full: !!rec.full })
    if (ws.readyState === 1 && ws.sendBinary(Buffer.from(rec.bytes, 'base64')) === 0) ws.data.stalled = true
    return true
  }

  private async drainStderr(ws: TermSocket, proc: TermProcess, gen: number): Promise<void> {
    const text = await new Response(proc.stderr).text().catch(() => '')
    if (text.trim() && ws.data.generation === gen) send(ws, { type: 'stderr', text: text.trim().slice(0, 400) })
  }
}

function send(ws: TermSocket, msg: object): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}
