import { type Snapshot, isIdle } from '../herdr.ts'
import type { FirstMessage } from '../protocol.ts'

export interface FirstMessageDeps {
  readScreen(pane: string): Promise<string>
  prompt(pane: string, text: string): Promise<unknown>
  /** The agent shows its idle input box: no numbered dialog, no trust prompt. */
  isReady(screen: string): boolean
  /** The per-pane lock the actions type under; a busy pane is retried on the next tick. */
  locks?: { run<T>(pane: string, fn: () => Promise<T>): Promise<T>; busy(pane: string): boolean }
  now?: () => number
}

export const EXPIRE_MS = 15 * 60_000
// Claude Code paints its prompt a beat before it accepts input; wait for two ready ticks in a row.
const READY_TICKS = 2
/** A pane missing from the snapshot right after `add` may only be newer than that snapshot. */
const GONE_GRACE_MS = 30_000

interface Entry {
  text: string
  at: number
  ready: number
  status: FirstMessage['status']
  error?: FirstMessage['error']
  detail?: string
}

/**
 * First messages that cannot ride on the agent's argv (slash commands, multi-line text): held until the
 * new agent is ready, then sent with `herdr agent prompt`. One that could not be sent stays as `failed` for
 * the browser to offer again or dismiss. A failed prompt is never retried on its own: a timeout may still
 * have delivered it.
 */
export class FirstMessageQueue {
  private entries = new Map<string, Entry>()
  private now: () => number

  constructor(private deps: FirstMessageDeps) {
    this.now = deps.now ?? Date.now
  }

  add(pane: string, text: string): void {
    this.entries.set(pane, { text, at: this.now(), ready: 0, status: 'queued' })
  }

  dismiss(pane: string): void {
    this.entries.delete(pane)
  }

  list(): FirstMessage[] {
    return [...this.entries].map(([pane, e]) => ({
      pane,
      text: e.text,
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
      ...(e.detail ? { detail: e.detail } : {}),
    }))
  }

  private pending(pane: string, entry: Entry): boolean {
    return this.entries.get(pane) === entry && entry.status === 'queued'
  }

  /** Called once per hub refresh. The hub never runs two refreshes at once, so flushes never overlap. */
  async flush(snap: Snapshot): Promise<void> {
    const panes = new Set(snap.panes.map(p => p.pane_id))
    for (const [pane, entry] of [...this.entries]) {
      if (!panes.has(pane) && this.now() - entry.at > GONE_GRACE_MS) {
        this.entries.delete(pane)
        continue
      }
      if (entry.status !== 'queued') continue
      if (this.now() - entry.at > EXPIRE_MS) {
        Object.assign(entry, { status: 'failed', error: 'expired', detail: 'The agent never became ready' })
        continue
      }
      if (this.deps.locks?.busy(pane)) continue
      const agent = snap.agents.find(a => a.pane_id === pane)
      const screen = agent && isIdle(agent.agent_status) ? await this.deps.readScreen(pane).catch(() => '') : ''
      if (!this.pending(pane, entry)) continue
      entry.ready = screen && this.deps.isReady(screen) ? entry.ready + 1 : 0
      if (entry.ready < READY_TICKS) continue
      // Dismissed, replaced, or made moot by a reply while the screen was read or the lock awaited: the
      // entry object is the token, and only the one still queued may be sent.
      const send = async () => {
        if (!this.pending(pane, entry)) return false
        await this.deps.prompt(pane, entry.text)
        return true
      }
      try {
        const sent = await (this.deps.locks ? this.deps.locks.run(pane, send) : send())
        if (sent && this.entries.get(pane) === entry) this.entries.delete(pane)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        console.error('first message', pane, detail)
        if (this.entries.get(pane) === entry) Object.assign(entry, { status: 'failed', error: 'send_failed', detail })
      }
    }
  }
}
