import { MAX_TURNS, codexSessions, locateTranscript, modelCatalog, readThread, slashCommands } from '../agents/index.ts'
import { herdr, paneCwd } from '../herdr.ts'
import { workingTreeDiff } from '../lib/git.ts'
import type {
  AgentKind,
  CodexSession,
  Command,
  Diff,
  DirChoices,
  DirCompletions,
  ModelCatalog,
  Thread,
} from '../protocol.ts'
import { isUnseen, parseLive, slashCommandOutput } from '../tui/index.ts'
import { completeDirs, dirChoices } from './dirs.ts'
import { resolveFile } from './files.ts'
import { UserError } from './http.ts'
import type { StateHub } from './hub.ts'

/** The read-only GET endpoints, resolved against the hub's latest snapshot. */
export interface Queries {
  thread(pane: string, turns: number): Promise<Thread>
  diff(pane: string): Promise<Diff>
  models(kind: AgentKind): ModelCatalog
  commands(kind: AgentKind, cwd: string): { commands: Command[]; skills: Command[] }
  commandOutput(pane: string, command: string): Promise<{ text: string | null }>
  /** The pane's text, its scrollback included, for finding in the terminal. */
  paneText(pane: string): Promise<{ text: string }>
  /** The conversations a Codex pane may be showing, for the user to say which one it is. */
  sessions(pane: string): Promise<{ sessions: CodexSession[] }>
  dirs(workspace: string | null): DirChoices
  complete(path: string): DirCompletions
  /** A path an agent wrote, resolved against its pane's folder. */
  filePath(pane: string, path: string): string
}

const EMPTY_THREAD: Thread = {
  turns: [],
  more: 0,
  meta: {
    model: null,
    effort: null,
    todos: [],
    pending: [],
    goal: null,
    version: 'none',
    path: null,
    truncated: false,
    maxTurns: MAX_TURNS,
    live: null,
  },
}
// How far back finding in the terminal looks: a shell's scrollback; an agent's screen is all herdr has of it.
const FIND_LINES = 5000
// Enough scrollback for long /status or /cost panels.
// A reply in progress, from the bottom up; Claude Code keeps it out of scrollback until it is done anyway.
const LIVE_LINES = 300

type HubReader = Pick<StateHub, 'view' | 'pane' | 'snapshot' | 'workspace'>

export interface QueryOptions {
  home: string
  recentDirs(): string[]
  /** Workspace labels hidden from the sidebar: their folders are not offered. */
  hidden?: ReadonlySet<string>
  readRecent?(pane: string, lines: number): Promise<string>
  now?(): number
}

/** The reply on screen that the newest turn does not have yet, or null. */
export function liveReply(
  kind: 'claude' | 'codex',
  screen: string,
  thread: Thread,
  now: number,
): Thread['meta']['live'] {
  const text = parseLive(kind, screen)
  if (!text) return null
  const last = thread.turns.at(-1)
  const said = (last?.steps ?? []).flatMap(s => (s.type === 'text' ? [s.text] : []))
  return isUnseen(text, said) ? { text, at: now } : null
}

export function createQueries(hub: HubReader, opts: QueryOptions): Queries {
  const readRecent = opts.readRecent ?? herdr.readRecent
  const now = opts.now ?? Date.now
  return {
    async thread(pane, turns) {
      const view = hub.view(pane)
      if (!view) throw new UserError('no_agent', `No agent in pane ${pane}`, 404)
      if (view.kind !== 'claude' && view.kind !== 'codex') return EMPTY_THREAD
      const path = await locateTranscript({ pane, kind: view.kind, session: view.session, cwd: view.cwd })
      const thread = path ? readThread(view.kind, path, turns) : EMPTY_THREAD
      if (view.status !== 'working') return thread
      const screen = await readRecent(pane, LIVE_LINES).catch(() => '')
      const live = liveReply(view.kind, screen, thread, now())
      return live ? { ...thread, meta: { ...thread.meta, live } } : thread
    },
    filePath(pane, path) {
      const p = hub.pane(pane)
      const cwd = hub.view(pane)?.cwd || (p && paneCwd(p))
      if (!cwd) throw new UserError('unknown_pane', `No pane ${pane}`, 404)
      return resolveFile(path, cwd, opts.home)
    },
    async diff(pane) {
      const p = hub.pane(pane)
      const cwd = hub.view(pane)?.cwd || (p && paneCwd(p))
      if (!cwd) throw new UserError('unknown_pane', `No pane ${pane}`, 404)
      // Outside a git work tree there is simply nothing to review; the UI polls this, so no error.
      return (await workingTreeDiff(cwd)) ?? { files: [], diff: '', added: 0, removed: 0 }
    },
    models: kind => modelCatalog(kind),
    commands: (kind, cwd) => slashCommands(kind, cwd),
    async commandOutput(pane, command) {
      if (!hub.pane(pane)) throw new UserError('unknown_pane', `No pane ${pane}`, 404)
      return { text: slashCommandOutput(await herdr.readScreen(pane), command) }
    },
    async paneText(pane) {
      if (!hub.pane(pane)) throw new UserError('unknown_pane', `No pane ${pane}`, 404)
      return { text: (await readRecent(pane, FIND_LINES)).replace(/\s+$/, '') }
    },
    async sessions(pane) {
      const view = hub.view(pane)
      if (view?.kind !== 'codex') throw new UserError('not_codex', `No Codex agent in pane ${pane}`, 404)
      return { sessions: await codexSessions(pane, view.cwd) }
    },
    dirs(workspace) {
      const snap = hub.snapshot
      if (workspace === null) {
        // Any folder: the recent ones first, then those the visible workspaces work in.
        const hidden = new Set((snap?.workspaces ?? []).filter(w => opts.hidden?.has(w.label)).map(w => w.workspace_id))
        const open = (snap?.panes ?? []).filter(p => !hidden.has(p.workspace_id)).map(paneCwd)
        return dirChoices({ paneCwds: [], recent: [...opts.recentDirs(), ...open], home: opts.home })
      }
      if (!hub.workspace(workspace)) throw new UserError('unknown_workspace', `No workspace ${workspace}`, 404)
      const paneCwds = (snap?.panes ?? []).filter(p => p.workspace_id === workspace).map(paneCwd)
      return dirChoices({ paneCwds, recent: opts.recentDirs(), home: opts.home })
    },
    complete: path => ({ dirs: completeDirs(path, opts.home) }),
  }
}
