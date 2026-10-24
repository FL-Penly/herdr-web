import { config } from './config.ts'
import { exec } from './lib/exec.ts'
import type { AgentStatus, Layout } from './protocol.ts'
import { stripAnsi } from './tui/screen.ts'

// Shapes of `herdr api snapshot` (herdr 0.9.5), trimmed to the fields herdr-web reads.
export interface Snapshot {
  workspaces: Workspace[]
  tabs: Tab[]
  panes: Pane[]
  agents: Agent[]
  layouts: Layout[]
}
export interface Workspace {
  workspace_id: string
  label: string
  number: number
  agent_status: string
}
export interface Tab {
  tab_id: string
  workspace_id: string
  label: string
  number: number
}
export interface Pane {
  pane_id: string
  tab_id: string
  workspace_id: string
  cwd: string
  foreground_cwd?: string
  label?: string
  terminal_title_stripped?: string
}
export interface Agent extends Pane {
  agent: string
  agent_status: AgentStatus
  agent_session?: { value?: string } | null
  name?: string
  completion_seq?: number
  state_change_seq?: number
}
export interface ProcessInfo {
  foreground_processes?: { pid: number; name?: string; argv?: string[]; cwd?: string }[]
}

/** The folder a pane is in now: its foreground process's, else the shell's. */
export function paneCwd(p: Pane): string {
  return p.foreground_cwd || p.cwd
}

/** The agent finished its turn and waits for input. */
export function isIdle(status: AgentStatus): boolean {
  return status === 'idle' || status === 'done'
}

/** herdr ids such as `w3:p1`. They become herdr argv, which has no `--`, so nothing may start with `-`. */
export const HERDR_ID = /^\w[\w:.-]{0,63}$/

export class HerdrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HerdrError'
  }
}

export function logInput(pane: string, what: string): void {
  console.log(`input ${pane}: ${what}`)
}

const label = (args: string[]) => `herdr ${args.slice(0, 2).join(' ')}`

async function run(args: string[], timeoutMs = 10_000): Promise<string> {
  const r = await exec([config.herdrBin, ...args], { timeoutMs })
  if (r.timedOut) throw new HerdrError(`${label(args)}: timed out after ${timeoutMs / 1000}s`)
  if (r.code !== 0) throw new HerdrError(`${label(args)}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
  return r.stdout
}

/** The `result` of a herdr command that prints a JSON envelope; its shape is trusted, as in `Snapshot`. */
async function result<T>(args: string[]): Promise<T> {
  const out = await run(args)
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    throw new HerdrError(`${label(args)}: unexpected output ${out.trim().slice(0, 300)}`)
  }
  const value = (parsed as { result?: T } | null)?.result
  if (value == null) throw new HerdrError(`${label(args)}: no result in ${out.trim().slice(0, 300)}`)
  return value
}

/** A thin, typed wrapper over the herdr CLI. */
export const herdr = {
  snapshot: async (): Promise<Snapshot> => (await result<{ snapshot: Snapshot }>(['api', 'snapshot'])).snapshot,
  readScreen: (pane: string, lines = 60) =>
    run(['pane', 'read', pane, '--source', 'visible', '--lines', String(lines)]),
  /** The visible screen with SGR attributes, to tell typed text from a dim placeholder. */
  readStyled: (pane: string, lines = 60) =>
    run(['pane', 'read', pane, '--source', 'visible', '--lines', String(lines), '--ansi']),
  /**
   * Rows above the screen too, as far as the pane's scrollback has them. Read with `--ansi` and stripped: as
   * plain text, herdr 0.9.5 gets more lines than the screen of an idle full-screen app (Claude Code, Codex) by
   * scrolling the app up with wheel events and back down, which the user sees in herdr. Never that way.
   */
  readRecent: async (pane: string, lines = 80) =>
    stripAnsi(await run(['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(lines), '--ansi'])),
  // Everything herdr-web types into a pane is logged (key names and lengths, never the text), so anything
  // that moved a pane can be traced to herdr-web or ruled out.
  sendKeys: (pane: string, keys: string[]) => {
    logInput(pane, `keys ${keys.join(' ')}`)
    return run(['pane', 'send-keys', pane, ...keys])
  },
  sendText: (pane: string, text: string) => {
    logInput(pane, `text (${text.length} chars)`)
    return run(['pane', 'send-text', pane, text])
  },
  prompt: (pane: string, text: string) => {
    logInput(pane, `prompt (${text.length} chars)`)
    return run(['agent', 'prompt', pane, text])
  },
  focusAgent: (pane: string) => {
    logInput(pane, 'focus')
    return run(['agent', 'focus', pane])
  },
  /** Wait until herdr reports one of `statuses`; false on timeout. */
  waitAgent: async (pane: string, statuses: AgentStatus[], timeoutMs: number): Promise<boolean> => {
    const args = ['agent', 'wait', pane, ...statuses.flatMap(s => ['--until', s]), '--timeout', String(timeoutMs)]
    const r = await exec([config.herdrBin, ...args], { timeoutMs: timeoutMs + 5_000 })
    if (r.code === 0) return true
    if (/"timeout"/.test(r.stdout)) return false
    throw new HerdrError(`${label(args)}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
  },
  rename: (pane: string, name: string | null) => run(['agent', 'rename', pane, ...(name ? [name] : ['--clear'])]),
  createTab: async (workspace: string, cwd: string, label: string): Promise<string> =>
    (
      await result<{ root_pane: { pane_id: string } }>([
        'tab',
        'create',
        '--workspace',
        workspace,
        '--cwd',
        cwd,
        '--label',
        label,
        '--no-focus',
      ])
    ).root_pane.pane_id,
  /** A new workspace in `cwd`; its first tab's shell pane. */
  createWorkspace: async (cwd: string, label: string): Promise<string> =>
    (
      await result<{ root_pane: { pane_id: string } }>([
        'workspace',
        'create',
        '--cwd',
        cwd,
        '--label',
        label,
        '--no-focus',
      ])
    ).root_pane.pane_id,
  renameWorkspace: (workspace: string, label: string) => run(['workspace', 'rename', workspace, label]),
  closeTab: (tab: string) => run(['tab', 'close', tab]),
  runInPane: (pane: string, command: string) => run(['pane', 'run', pane, command]),
  processInfo: async (pane: string): Promise<ProcessInfo> =>
    (await result<{ process_info: ProcessInfo }>(['pane', 'process-info', '--pane', pane])).process_info,
}
