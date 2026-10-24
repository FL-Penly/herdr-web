#!/usr/bin/env bun
/**
 * Fork the Claude Code or Codex session in a herdr pane into a new pane or tab.
 *
 * Claude: the transcript is copied up to its newest message under a new session id, then
 * `claude <same flags> --resume <new id> -n "<title> · fork"` runs in the folder the session was recorded in,
 * with the original process's CLAUDE_* / ANTHROPIC_* environment (`--fork-session` only while it has no messages).
 * Codex: `codex fork <id>`, with the original CODEX_* / OPENAI_* environment.
 * `at` forks from an earlier reply instead of the end: a Claude message uuid, or `<rollout>#<byte offset>`
 * for Codex. The record is copied up to that point under a new session id, and the copy is resumed.
 *
 * CLI: bun fork.ts right|down|tab [pane] [--session ID] [--at MARK]
 *
 * Self-contained on purpose (node/bun builtins only): herdr installs this directory as a standalone plugin,
 * and herdr-web imports `forkSession` in-process.
 */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import type { Subprocess } from 'bun'

// $HOME first, as the shell sees it: Bun's homedir() ignores a HOME set after startup.
const home = () => process.env.HOME || homedir()

export type ForkMode = 'right' | 'down' | 'tab'

export interface ForkOptions {
  pane: string
  mode: ForkMode
  /** Session id to fork; by default herdr's session for the pane (Claude) or the pane's rollout (Codex). */
  session?: string
  /** Fork point: a Claude message uuid, or `<rollout path>#<byte offset>` for Codex. */
  at?: string
  herdrBin?: string
  /** Claude config dirs searched for transcripts after the agent's own; default: this process's CLAUDE_CONFIG_DIR. */
  claudeDirs?: string[]
  codexHome?: string
}

export type ForkErrorCode = 'not_agent' | 'no_session' | 'not_found' | 'bad_fork_point' | 'herdr'

export class ForkError extends Error {
  constructor(
    message: string,
    readonly code: ForkErrorCode,
  ) {
    super(message)
    this.name = 'ForkError'
  }
}

/** Flags of the original claude command worth carrying over to the fork. `true`: takes a value. */
const KEEP_FLAGS: Record<string, boolean> = {
  '--dangerously-skip-permissions': false,
  '--allow-dangerously-skip-permissions': false,
  '--permission-mode': true,
  '--model': true,
  '--effort': true,
  '--settings': true,
  '--setting-sources': true,
  '--add-dir': true,
  '--mcp-config': true,
  '--strict-mcp-config': false,
  '--plugin-dir': true,
  '--append-system-prompt': true,
  '--system-prompt': true,
  '--agent': true,
  '--chrome': false,
  '--no-chrome': false,
  '--ide': false,
}
const VARIADIC = new Set(['--add-dir', '--mcp-config'])

export const CLAUDE_ENV_PREFIXES = ['CLAUDE_', 'ANTHROPIC_'] as const
export const CODEX_ENV_PREFIXES = ['CODEX_', 'OPENAI_'] as const
// Markers of the parent Claude process; inheriting them makes the fork think it runs inside another session.
const ENV_SKIP = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'])

const HERDR_TIMEOUT_MS = 20_000
const FIRST_LINE_MAX = 4 << 20
const ROLLOUT_CANDIDATES = 200
const CWD_SCAN_LINES = 200
/** Codex rollout fields that carry the session's own id (the meta line, thread events, usage records). */
const CODEX_ID_KEYS = new Set(['id', 'session_id', 'thread_id', 'conversation_id'])

export const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

export function keepFlags(argv: readonly string[]): string[] {
  const kept: string[] = []
  let i = 1
  while (i < argv.length) {
    const arg = argv[i] as string
    const eq = arg.indexOf('=')
    const name = eq < 0 ? arg : arg.slice(0, eq)
    const takesValue = KEEP_FLAGS[name]
    if (takesValue !== undefined) {
      kept.push(arg)
      if (takesValue && eq < 0) {
        i++
        while (i < argv.length && !(argv[i] as string).startsWith('-')) {
          kept.push(argv[i] as string)
          i++
          if (!VARIADIC.has(name)) break
        }
        continue
      }
    }
    i++
  }
  return kept
}

export function parseEnviron(raw: Uint8Array | string, prefixes: readonly string[]): Record<string, string> {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
  const env: Record<string, string> = {}
  for (const item of text.split('\0')) {
    const eq = item.indexOf('=')
    if (eq <= 0) continue
    const key = item.slice(0, eq)
    // The names end up unquoted in `export NAME=…`, so only shell-safe names pass.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ENV_SKIP.has(key)) continue
    if (prefixes.some(p => key.startsWith(p))) env[key] = item.slice(eq + 1)
  }
  return env
}

/** POSIX quoting; safe words stay bare so the command echoed in the new pane stays readable. */
export function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

export const shellJoin = (argv: readonly string[]) => argv.map(shellQuote).join(' ')

export function findPaneIds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) findPaneIds(v, out)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'pane_id' && typeof v === 'string') out.push(v)
      findPaneIds(v, out)
    }
  }
  return out
}

export function codexArgvSession(argv: readonly string[]): { resume: string | null; parent: string | null } {
  let resume: string | null = null
  let parent: string | null = null
  for (let i = 0; i < argv.length - 1; i++) {
    const next = argv[i + 1]
    if (!isUuid(next)) continue
    if (argv[i] === 'resume') resume ??= next
    else if (argv[i] === 'fork') parent ??= next
  }
  return { resume, parent }
}

function readHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0))
  } finally {
    closeSync(fd)
  }
}

function readFirstLine(path: string): string {
  for (let size = 16 << 10; ; size *= 4) {
    const head = readHead(path, size)
    const nl = head.indexOf(10)
    if (nl >= 0) return head.subarray(0, nl).toString('utf8')
    if (head.length < size || size >= FIRST_LINE_MAX) return head.toString('utf8')
  }
}

function parseObject(line: string): Record<string, any> | null {
  try {
    const v = JSON.parse(line)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function findClaudeTranscript(session: string, configDirs: readonly string[]): string | null {
  if (!isUuid(session)) return null
  for (const dir of configDirs) {
    const projects = join(dir, 'projects')
    for (const project of listDir(projects)) {
      const path = join(projects, project, `${session}.jsonl`)
      if (existsSync(path)) return path
    }
  }
  return null
}

export function transcriptCwd(path: string): string | null {
  let lines: string[]
  try {
    lines = readHead(path, 4 << 20)
      .toString('utf8')
      .split('\n')
      .slice(0, CWD_SCAN_LINES)
  } catch {
    return null
  }
  for (const line of lines) {
    const cwd = parseObject(line)?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
  }
  return null
}

const toolUseIds = (row: Record<string, any>): string[] =>
  Array.isArray(row.message?.content)
    ? row.message.content.filter((b: any) => b?.type === 'tool_use' && typeof b.id === 'string').map((b: any) => b.id)
    : []

const answersOnly = (row: Record<string, any>, open: Set<string>): string[] | null => {
  const content = row.message?.content
  if (!Array.isArray(content) || !content.length) return null
  const ids: string[] = []
  for (const block of content) {
    if (block?.type !== 'tool_result' || !open.has(block.tool_use_id)) return null
    ids.push(block.tool_use_id)
  }
  return ids
}

/**
 * Copy a Claude transcript up to and including message `at` into `<new id>.jsonl` next to it.
 *
 * Claude writes one row per content block, so the assistant message `at` belongs to may continue on later
 * rows (text, then tool_use), followed by the tool_result rows answering it. Those are kept too, so the
 * fork never resumes on a dangling tool_use. Bookkeeping rows in between are kept only when more of the
 * message follows them.
 */
export function claudeCut(transcript: string, session: string, at: string): { id: string; path: string } {
  const id = randomUUID()
  const out: string[] = []
  let pending: string[] = []
  let found = false
  let messageId: string | undefined
  const open = new Set<string>()
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    const row = parseObject(line)
    if (!row) continue
    if (row.sessionId === session) row.sessionId = id
    if (row.session_id === session) row.session_id = id
    const text = `${JSON.stringify(row)}\n`
    if (!found) {
      out.push(text)
      if (row.uuid !== at) continue
      found = true
      if (row.type !== 'assistant' || typeof row.message?.id !== 'string') break
      messageId = row.message.id
      for (const t of toolUseIds(row)) open.add(t)
      continue
    }
    if (row.type === 'assistant' && row.message?.id === messageId) {
      out.push(...pending, text)
      pending = []
      for (const t of toolUseIds(row)) open.add(t)
      continue
    }
    const answered = row.type === 'user' ? answersOnly(row, open) : null
    if (answered) {
      out.push(...pending, text)
      pending = []
      for (const t of answered) open.delete(t)
      continue
    }
    if (row.type === 'user' || row.type === 'assistant') break
    pending.push(text)
  }
  if (!found) throw new ForkError(`message ${at} not found in the transcript`, 'bad_fork_point')
  const path = join(transcript, '..', `${id}.jsonl`)
  writeFileSync(path, out.join(''), { flag: 'wx', mode: 0o600 })
  return { id, path }
}

/**
 * The uuid of the newest message row on the main thread, where a whole-session fork is cut. Rows after it
 * (titles, snapshots, the last prompt) are bookkeeping that the copy does without.
 */
export function lastMessageUuid(transcript: string): string | null {
  const lines = readFileSync(transcript, 'utf8').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    if (!line.includes('"uuid"')) continue
    const row = parseObject(line)
    if (row && typeof row.uuid === 'string' && !row.isSidechain && (row.type === 'user' || row.type === 'assistant'))
      return row.uuid
  }
  return null
}

function replaceIds(value: unknown, from: string, to: string): void {
  if (Array.isArray(value)) {
    for (const v of value) replaceIds(v, from, to)
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      if (v === from && CODEX_ID_KEYS.has(k)) obj[k] = to
      else replaceIds(v, from, to)
    }
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A rollout row that closes a turn: Codex's `task_complete`, or `turn_aborted` after an interrupt. */
function endsTurn(row: Record<string, any> | null): boolean {
  const type = row?.type === 'event_msg' ? row.payload?.type : undefined
  return type === 'task_complete' || type === 'turn_aborted'
}

/**
 * Copy a Codex rollout up to a turn boundary (`<path>#<byte offset>`) into a new rollout under a fresh id.
 * Only id-bearing fields are rewritten, so the old id inside user text or tool output stays as it was.
 */
export function codexCut(at: string, codexHome: string, now = new Date()): { id: string; path: string } {
  const hash = at.lastIndexOf('#')
  const src = at.slice(0, hash)
  const offText = at.slice(hash + 1)
  const root = resolve(codexHome, 'sessions') + sep
  if (
    hash < 0 ||
    !/^\d+$/.test(offText) ||
    !src.endsWith('.jsonl') ||
    src.includes('..') ||
    !resolve(src).startsWith(root)
  )
    throw new ForkError(`not a Codex fork point: ${at.slice(0, 200)}`, 'bad_fork_point')
  const off = Number(offText)
  let size: number
  try {
    size = statSync(src).size
  } catch {
    throw new ForkError(`rollout not found: ${src}`, 'not_found')
  }
  const notBoundary = () =>
    new ForkError(`fork point ${off} is not at a turn boundary of ${basename(src)}`, 'bad_fork_point')
  // Checked before reading: the offset comes from the request and sizes the buffer.
  if (off > size) throw notBoundary()
  const data = readHead(src, off)
  const nl = data.indexOf(10)
  if (data.length !== off || data[off - 1] !== 10 || nl < 0 || off <= nl + 1) throw notBoundary()
  // A line boundary is not enough: inside a turn it can leave a tool call without its output.
  const lastLine = data.subarray(data.lastIndexOf(10, off - 2) + 1, off - 1).toString('utf8')
  if (!endsTurn(parseObject(lastLine))) throw notBoundary()
  const meta = parseObject(data.subarray(0, nl).toString('utf8'))
  const payload = meta?.payload
  if (meta?.type !== 'session_meta' || !payload || typeof payload !== 'object')
    throw new ForkError(`${basename(src)} does not start with session_meta`, 'bad_fork_point')
  const old: unknown = payload.id ?? payload.session_id
  const id = randomUUID()
  for (const k of ['id', 'session_id']) if (k in payload) payload[k] = id
  payload.timestamp = now.toISOString().replace(/\.\d{3}Z$/, '.000Z')

  const lines = [JSON.stringify(meta)]
  for (const line of data
    .subarray(nl + 1, off - 1)
    .toString('utf8')
    .split('\n')) {
    const row = typeof old === 'string' && line.includes(old) ? parseObject(line) : null
    if (row) replaceIds(row, old as string, id)
    lines.push(row ? JSON.stringify(row) : line)
  }

  const day = join(codexHome, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
  mkdirSync(day, { recursive: true })
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  const path = join(day, `rollout-${stamp}-${id}.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
  return { id, path }
}

export function newestCodexSession(codexHome: string, cwd: string, exclude?: string | null): string | null {
  const sessions = join(codexHome, 'sessions')
  const files: { path: string; mtime: number }[] = []
  for (const y of listDir(sessions))
    for (const m of listDir(join(sessions, y)))
      for (const d of listDir(join(sessions, y, m)))
        for (const f of listDir(join(sessions, y, m, d))) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue
          const path = join(sessions, y, m, d, f)
          try {
            files.push({ path, mtime: statSync(path).mtimeMs })
          } catch {}
        }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const { path } of files.slice(0, ROLLOUT_CANDIDATES)) {
    let payload: Record<string, any> | undefined
    try {
      payload = parseObject(readFirstLine(path))?.payload
    } catch {
      continue
    }
    if (!payload || payload.cwd !== cwd || payload.originator === 'codex_exec') continue
    const id = payload.id ?? payload.session_id
    if (typeof id === 'string' && id !== exclude) return id
  }
  return null
}

interface HerdrProcess {
  pid: number
  name?: string
  argv?: string[]
  cwd?: string
}

interface HerdrAgent {
  agent?: string
  cwd?: string
  foreground_cwd?: string
  workspace_id?: string
  terminal_title_stripped?: string
  agent_session?: { value?: string } | null
}

async function herdrJson(bin: string, args: string[]): Promise<Record<string, any>> {
  const what = `herdr ${args.slice(0, 2).join(' ')}`
  let proc: Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn([bin, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  } catch (e) {
    throw new ForkError(`${what}: ${(e as Error).message}`, 'herdr')
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, HERDR_TIMEOUT_MS)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  if (timedOut) throw new ForkError(`${what}: timed out after ${HERDR_TIMEOUT_MS / 1000}s`, 'herdr')
  if (code !== 0) throw new ForkError(`${what}: ${(err || out).trim().slice(0, 200)}`, 'herdr')
  // Commands such as `pane run` print nothing on success.
  if (!out.trim()) return {}
  const parsed = parseObject(out.trim())
  if (!parsed) throw new ForkError(`${what}: unexpected output ${JSON.stringify(out.slice(0, 200))}`, 'herdr')
  return parsed
}

function agentProcess(procs: readonly HerdrProcess[], kind: string): { proc: HerdrProcess; argv: string[] } | null {
  for (const proc of procs) {
    const argv = proc.argv ?? []
    if (proc.name === kind || basename(argv[0] ?? '') === kind) return { proc, argv }
    // npm installs run as `node /…/bin/claude …`.
    if (basename(argv[1] ?? '') === kind) return { proc, argv: argv.slice(1) }
  }
  return null
}

function processEnv(pid: number | undefined, prefixes: readonly string[]): Record<string, string> {
  if (!pid) return {}
  try {
    return parseEnviron(readFileSync(`/proc/${pid}/environ`), prefixes)
  } catch {
    // No /proc (macOS) or not our process: the fork runs with the new shell's own environment.
    return {}
  }
}

const unique = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))]

function envFileDir(): string {
  const runtime = process.env.XDG_RUNTIME_DIR
  return runtime && existsSync(runtime) ? runtime : tmpdir()
}

export async function forkSession(o: ForkOptions): Promise<{ pane: string }> {
  const bin = o.herdrBin ?? process.env.HERDR_BIN_PATH ?? 'herdr'
  const agent: HerdrAgent | undefined = (await herdrJson(bin, ['agent', 'get', o.pane])).result?.agent
  const kind = agent?.agent
  if (!agent || (kind !== 'claude' && kind !== 'codex'))
    throw new ForkError(`pane ${o.pane}: not a claude/codex pane (agent=${kind ?? 'none'})`, 'not_agent')

  const info = await herdrJson(bin, ['pane', 'process-info', '--pane', o.pane])
  const procs: HerdrProcess[] = info.result?.process_info?.foreground_processes ?? []
  const found = agentProcess(procs, kind)
  let cwd = found?.proc.cwd || agent.foreground_cwd || agent.cwd || home()
  let session = o.session || agent.agent_session?.value || undefined

  let cmd: string[]
  let env: Record<string, string>
  let cut: string | null = null
  if (kind === 'claude') {
    env = processEnv(found?.proc.pid, CLAUDE_ENV_PREFIXES)
    if (!session) throw new ForkError(`pane ${o.pane}: could not find the claude session id`, 'no_session')
    // The agent's own config dir is its CLAUDE_CONFIG_DIR, else Claude's default.
    const dirs = unique([
      env.CLAUDE_CONFIG_DIR || join(home(), '.claude'),
      ...(o.claudeDirs ?? [process.env.CLAUDE_CONFIG_DIR]),
    ])
    const transcript = findClaudeTranscript(session, dirs)
    if (transcript) cwd = transcriptCwd(transcript) ?? cwd
    const title = Array.from((agent.terminal_title_stripped || 'session').trim())
      .slice(0, 40)
      .join('')
    const flags = keepFlags(found?.argv ?? [])
    // `--fork-session` writes the new transcript only with the first new message, so until then the fork has
    // no id and shows no history. A whole fork is therefore a cut at the newest message, like a fork from `at`.
    const at = o.at ?? (transcript ? lastMessageUuid(transcript) : null)
    if (at) {
      if (!transcript) throw new ForkError(`transcript for ${session} not found`, 'not_found')
      const copy = claudeCut(transcript, session, at)
      cut = copy.path
      cmd = ['claude', ...flags, '--resume', copy.id, '-n', `${title} · fork`]
    } else {
      cmd = ['claude', ...flags, '--resume', session, '--fork-session', '-n', `${title} · fork`]
    }
  } else {
    env = processEnv(found?.proc.pid, CODEX_ENV_PREFIXES)
    const codexHome = o.codexHome ?? process.env.CODEX_HOME ?? join(home(), '.codex')
    if (o.at) {
      const copy = codexCut(o.at, codexHome)
      cut = copy.path
      cmd = ['codex', 'resume', copy.id]
    } else {
      // herdr has no Codex hooks, so the id comes from argv or the newest rollout recorded in this folder.
      if (!isUuid(session)) {
        const { resume, parent } = codexArgvSession(found?.argv ?? [])
        session = resume ?? newestCodexSession(codexHome, cwd, parent) ?? parent ?? undefined
      }
      if (!session) throw new ForkError(`pane ${o.pane}: could not find the codex session id`, 'no_session')
      cmd = ['codex', 'fork', session]
    }
  }

  const workspace = agent.workspace_id
  if (o.mode === 'tab' && !workspace) throw new ForkError(`pane ${o.pane}: herdr reported no workspace`, 'herdr')

  let envFile: string | null = null
  let pane: string | undefined
  try {
    const made =
      o.mode === 'tab'
        ? await herdrJson(bin, ['tab', 'create', '--workspace', workspace as string, '--cwd', cwd, '--label', 'fork'])
        : await herdrJson(bin, ['pane', 'split', '--pane', o.pane, '--direction', o.mode, '--cwd', cwd, '--focus'])
    pane = findPaneIds(made).find(p => p !== o.pane)
    if (!pane) throw new ForkError(`could not find the new pane in: ${JSON.stringify(made).slice(0, 200)}`, 'herdr')

    // The env goes through a 0600 file the new shell sources and deletes, so tokens never show on screen.
    // It is written only now that the pane exists, and removed below if starting the command fails.
    let line = shellJoin(cmd)
    if (Object.keys(env).length) {
      envFile = join(envFileDir(), `quick-fork-${randomUUID()}.env`)
      const body = Object.entries(env)
        .map(([k, v]) => `export ${k}=${shellQuote(v)}\n`)
        .join('')
      writeFileSync(envFile, body, { flag: 'wx', mode: 0o600 })
      line = `. ${shellQuote(envFile)}; rm -f ${shellQuote(envFile)}; ${line}`
    }
    await herdrJson(bin, ['pane', 'run', pane, line])
    return { pane }
  } catch (e) {
    if (envFile) rmSync(envFile, { force: true })
    if (cut) rmSync(cut, { force: true })
    // Do not leave an empty shell behind; a retry would open another one.
    if (pane) await herdrJson(bin, ['pane', 'close', pane]).catch(() => {})
    throw e
  }
}

export interface CliArgs {
  mode: ForkMode
  pane: string | null
  session?: string
  at?: string
}

export function parseCli(args: readonly string[], env: Record<string, string | undefined> = process.env): CliArgs {
  const mode = args[0] ?? 'right'
  if (mode !== 'right' && mode !== 'down' && mode !== 'tab') throw new Error(`unknown mode ${mode} (right|down|tab)`)
  const option = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 && i < args.length - 1 ? args[i + 1] : undefined
  }
  let pane: string | null = args[1] && !args[1].startsWith('--') ? args[1] : null
  if (!pane) {
    let context: Record<string, any> | null = null
    try {
      context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || '{}')
    } catch {}
    pane = context?.focused_pane_id || env.HERDR_PANE_ID || null
  }
  return { mode, pane, session: option('--session'), at: option('--at') }
}

async function notify(title: string, body: string) {
  const bin = process.env.HERDR_BIN_PATH ?? 'herdr'
  const proc = Bun.spawn([bin, 'notification', 'show', title, '--body', body.slice(0, 300)], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const timer = setTimeout(() => proc.kill(), 5000)
  await proc.exited
  clearTimeout(timer)
}

async function main() {
  try {
    const args = parseCli(process.argv.slice(2))
    if (!args.pane) throw new Error('no focused pane')
    const result = await forkSession({ pane: args.pane, mode: args.mode, session: args.session, at: args.at })
    console.log(JSON.stringify(result))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`quick-fork: ${message}`)
    // A toast only when herdr runs this as a plugin action; herdr-web reports its own errors.
    if (process.env.HERDR_PLUGIN_ACTION_ID || process.env.HERDR_PLUGIN_CONTEXT_JSON)
      await notify('Quick fork failed', message).catch(() => {})
    process.exit(1)
  }
}

if (import.meta.main) await main()
