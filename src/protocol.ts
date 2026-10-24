// The wire contract between the server and the browser. The frontend imports these through JSDoc
// (`@typedef {import('../../src/protocol.ts').AgentView} AgentView`), so keep it free of runtime code.

export type AgentKind = 'claude' | 'codex'
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface Branch {
  name: string
  ahead: number
  behind: number
}

export interface Option {
  /**
   * A digit for numbered dialogs, `nav:<offset from the cursor>` for arrow-key menus. Only a hint: the
   * server picks an option by `label` against the screen as it is when the click arrives.
   */
  key: string
  label: string
  desc?: string
  current?: boolean
}

export type InboxReason = 'permission' | 'trust' | 'choice' | 'blocked' | 'question' | 'done'

/**
 * Why an agent wants attention. `source` says where it was read from:
 * - `dialog`: a blocking TUI dialog (permission, trust, AskUserQuestion, …)
 * - `menu`: a menu the user opened themselves (`/model`, `/resume`, …) — not a wait
 * - `panel`: a read-only panel the user opened (`/status`, `/cost`, …) — `question` holds its text
 * - `asks`: Codex has `asks` async questions queued while it keeps working
 * - `transcript` / `screen`: the last reply, from the transcript or (fallback) the screen
 */
/** Claude Code's AskUserQuestion with several questions, one tab each and a last one to submit them all. */
export interface AskForm {
  /** The questions' tab titles, `done` once answered. */
  steps: { label: string; done: boolean }[]
  /** On the submit tab: each question and the answer chosen, not sent to Claude until submitted. */
  review: { question: string; answer: string }[] | null
}

export interface InboxEntry {
  reason: InboxReason
  source: 'dialog' | 'menu' | 'panel' | 'asks' | 'transcript' | 'screen'
  question: string
  options: Option[]
  message: string
  asks?: number
  /** The folder a trust dialog asks about. */
  folder?: string
  /** A dialog asking several questions in one go: where in it the user is. */
  form?: AskForm
  /**
   * Set on `dialog` entries: which showing of a blocking dialog this is, from when it appears until it is
   * answered or gives way to another (opaque, unique). Two prompts can look the same on screen, the end of the
   * same file say, and still ask about different changes: whatever was read about one belongs to its episode.
   */
  episode?: string
  snoozedUntil: number | null
}

export interface AgentView {
  pane: string
  tab: string
  workspace: string
  workspaceLabel: string
  tabLabel: string
  /** herdr's agent name: `claude` and `codex` get threads, any other agent shows its status only. */
  kind: string
  /** herdr agent name (`herdr agent rename`), the address other agents can dispatch to. */
  name: string | null
  title: string
  cwd: string
  status: AgentStatus
  since: number
  branch: Branch | null
  session: string | null
  activity: string | null
  /** Context used, percent. */
  ctx: number | null
  mode: string | null
  effort: string | null
  ultra: boolean
  model: string | null
  asks: number
  /** Background shells Claude Code still runs (`· 1 shell ·` in its footer); a finished turn can leave some. */
  shells: number
  /** The agent's input box is on screen: no panel, menu or dialog replaces it. */
  inputBox?: boolean
  inbox: InboxEntry | null
}

export interface TabView {
  id: string
  workspace: string
  label: string
  number: number
  panes: string[]
}

export interface TerminalView {
  pane: string
  workspace: string
  tab: string
  cwd: string
  title: string
}

export interface WorkspaceView {
  id: string
  label: string
  number: number
  cwd: string
  busy: boolean
  agents: number
}

export interface Layout {
  tab_id: string
  area: { width: number; height: number }
  panes: { pane_id: string; rect: { x: number; y: number; width: number; height: number } }[]
}

/**
 * A first message for a new session that could not go on the agent's command line (a slash command, several
 * lines). `queued` until it is delivered (then it is gone); `failed` when sending it failed (`send_failed`:
 * not retried, a timeout may have delivered it) or the agent never became ready within 15 minutes
 * (`expired`). A failed one stays until `dismissFirstMessage` or a reply to that pane.
 */
export interface FirstMessage {
  pane: string
  text: string
  status: 'queued' | 'failed'
  /** Why it failed, set with `failed`. */
  error?: 'send_failed' | 'expired'
  /** The server's (English) explanation, for logs and tooltips. */
  detail?: string
}

/**
 * Messages waiting for the agent's turn to end, sent one per turn in order. `paused` after a web interrupt, a
 * failed send (`held: 'send_failed'`), a restart in the middle of a send (`maybe_sent`: it may have gone out),
 * the pane moving to another conversation (`session_changed`), or text typed in the terminal that went away
 * without starting a turn (`terminal_input`: a command such as Codex's `/new`); the message stays first.
 * `held: 'terminal_draft'` while text typed in the terminal sits in the input box.
 */
export interface ReplyQueue {
  pane: string
  items: { id: string; text: string }[]
  paused: boolean
  held?: 'terminal_draft' | 'send_failed' | 'maybe_sent' | 'session_changed' | 'terminal_input'
  /** The server's (English) explanation of a failed send. */
  detail?: string
}

/** Pushed on /ws/state whenever anything changes. */
export interface StatePayload {
  type: 'state'
  version: string
  home: string
  tabs: TabView[]
  agents: AgentView[]
  terminals: TerminalView[]
  workspaces: WorkspaceView[]
  layouts: Layout[]
  firstMessages: FirstMessage[]
  replyQueues: ReplyQueue[]
}

// ── Threads (/api/thread) ────────────────────────────────────────────────────

export type ToolKind = 'cmd' | 'edit' | 'read' | 'search' | 'web' | 'task' | 'todo' | 'plan' | 'skill' | 'ask' | 'other'

/** What a tool did, finer than its kind; the UI turns `tool.<kind>.<op>` into a label. */
export type ToolOp =
  | 'run'
  | 'edit'
  | 'write'
  | 'create'
  | 'delete'
  | 'file'
  | 'image'
  | 'grep'
  | 'fetch'
  | 'search'
  | 'task'
  | 'subagent'
  | 'update'
  | 'plan'
  | 'skill'
  | 'ask'
  | 'call'

export interface UserItem {
  type: 'user'
  text: string
  images: number
  /** Codex async-question replies, shown as answers instead of raw text. */
  answers?: { question: string; answer: string }[]
  ts: number
}

export interface TextItem {
  type: 'text'
  text: string
  ts: number
}

export interface ThinkItem {
  type: 'think'
  ts: number
}

export type NoteCode = 'goal.complete' | 'goal.paused' | 'goal.status' | 'goal.cleared' | 'command'

/** Something that happened outside a reply: a goal changed state, or a slash command printed output. */
export interface NoteItem {
  type: 'note'
  code: NoteCode
  /** Raw output for `command`; the goal's `reason` for `goal.complete`; the status for `goal.status`. */
  text?: string
  goal?: Goal
  ts: number
}

export interface ToolItem {
  type: 'tool'
  id: string
  tool: ToolKind
  op: ToolOp
  /** The raw tool name, shown for `other` (e.g. an MCP tool as `server · tool`). */
  name?: string
  detail: string
  status: 'ok' | 'error' | 'running'
  output?: string
  diff?: string
  added?: number
  removed?: number
  path?: string
  ts: number
}

export type Item = (UserItem | TextItem | ThinkItem | NoteItem | ToolItem) & {
  /** Where a fork from this reply starts: a Claude message uuid, or `<rollout path>#<byte offset>` for Codex. */
  forkAt?: string
}

export interface Turn {
  /** Stable across polls: the source offset of the turn's first row. */
  id: string
  user: UserItem | null
  steps: Item[]
  start: number
  end: number
  forkAt?: string
}

export interface Goal {
  text: string
  /** As Codex reports it: `active`, `paused` and `complete` are known; others are shown as-is. */
  status: string
  secs?: number
  tokens?: number
  turns?: number
}

export interface Ask {
  call: string
  title: string
  options: string[]
  answer?: string
}

export interface ThreadMeta {
  model: string | null
  effort: string | null
  todos: { content: string; status: string }[]
  pending: Ask[]
  goal: Goal | null
  version: string
  path: string | null
  /**
   * Older history exists that the API cannot return: dropped by the parser's item ceiling, or before the
   * part of a very large transcript that is read.
   */
  truncated: boolean
  /** The most turns `/api/thread` returns; asking for more gets this many. */
  maxTurns: number
  /**
   * The newest reply while it is still being written: assistant text visible in the agent's terminal that
   * the transcript does not have yet, read from the screen (plain text, no ANSI, at most about 8 KB). null
   * when the agent is not working or nothing new is on screen. Drop it once the transcript has the reply.
   */
  live: { text: string; at: number } | null
}

export interface Thread {
  turns: Turn[]
  /** Older turns `/api/thread` can still return with a larger `turns` (never counts `truncated` history). */
  more: number
  meta: ThreadMeta
}

// ── Catalogs (/api/commands, /api/models) ────────────────────────────────────

export interface Command {
  name: string
  desc: string
  type: 'builtin' | 'command' | 'skill'
  origin: 'builtin' | 'user' | 'project' | 'plugin'
}

export interface Model {
  /** `''` is the agent's own default. */
  id: string
  label: string
  efforts: string[]
  effort?: string
}

export interface ModelCatalog {
  models: Model[]
  default: { model: string; effort: string }
  /**
   * Why the agent's own model list is missing: `no_cache` when Codex has not written `models_cache.json` yet
   * (it does on its first run). `models` then holds only the model configured in its config.toml, if any.
   */
  unavailable?: 'no_cache'
}

export interface DiffFile {
  path: string
  added: number
  removed: number
  /** A new file git does not track yet; `diff` holds it as a `new file` patch (all additions). */
  untracked?: boolean
  binary?: true
}

/** GET /api/dirs?workspace=: where a new session could start, most likely first. */
export interface DirChoices {
  /**
   * Existing directories, deduped: the workspace's pane cwds, then recent new-session dirs, then home. Without
   * `workspace`: recent new-session dirs, then the folders of the visible workspaces' panes, then home.
   */
  recent: string[]
  home: string
}

/** GET /api/complete?path=: subdirectories matching the last segment (`~` is home). */
export interface DirCompletions {
  dirs: string[]
}

export interface Diff {
  files: DiffFile[]
  /**
   * The unified patch of every file, tracked changes first. An untracked text file up to 256 KB comes as a
   * synthetic `diff --git … new file mode 100644` patch; a larger one as a hunk-less stub followed by the
   * line `(file too large to show)`. Totals count untracked files too.
   */
  diff: string
  added: number
  removed: number
}

// ── Actions (POST /api/act) ──────────────────────────────────────────────────

export type ForkMode = 'right' | 'down' | 'tab'

/** A conversation a Codex pane may be showing (`GET /api/sessions`), for the user to say which one it is. */
export interface CodexSession {
  path: string
  /** The newest user message (cut to a preview), and when the rollout was last written (ms). */
  prompt: string | null
  at: number
  current: boolean
  /** Its newest message is the newest one echoed on the pane's screen. */
  onScreen: boolean
}

export type Action =
  /**
   * `cwd` (absolute or `~/…`) must be an existing directory, else code `bad_cwd`; it is remembered for
   * `/api/dirs`. Without it, the workspace's first pane's folder (home for a new workspace). It opens a tab in
   * `workspace`, or creates a workspace labelled `newWorkspace` and starts in its first pane: exactly one of
   * the two, else `bad_workspace`. `request` (see `RequestId`) makes it idempotent.
   */
  | {
      op: 'new'
      workspace?: string
      newWorkspace?: string
      agent?: AgentKind
      cwd?: string
      text?: string
      model?: string
      effort?: string
      request?: RequestId
    }
  | { op: 'rename'; pane: string; name: string }
  | { op: 'renameWorkspace'; workspace: string; label: string }
  | { op: 'closeTab'; tab: string }
  /**
   * Type `text` into the agent's input box and submit it. When the box already holds text typed in the terminal,
   * nothing is sent: the action fails with code `terminal_draft` and `draft` (that text). `discardDraft` is the
   * draft the user agreed to replace: the box is emptied first when it still holds that text (whitespace aside);
   * otherwise the action fails with `terminal_draft` again and the draft now there.
   */
  | { op: 'reply'; pane: string; text: string; discardDraft?: string }
  /**
   * Close a panel or menu left open over the agent's input box (`/config`), with Esc, so the terminal follows the
   * browser back to the chat. A working agent is not sent Esc. Fails with `no_input_box` when it stays covered.
   */
  | { op: 'closePanel'; pane: string }
  | { op: 'cycleMode'; pane: string }
  | { op: 'queueReply'; pane: string; text: string }
  | { op: 'unqueueReply'; pane: string; id: string }
  | { op: 'resumeQueue'; pane: string }
  | { op: 'pinSession'; pane: string; path: string }
  /**
   * Pick the option with this `label` (`key` only tells apart equal labels). With `question`, only while the
   * dialog on screen still asks it; otherwise the action fails with code `stale_dialog`.
   */
  | { op: 'option'; pane: string; key: string; label: string; question?: string; text?: string }
  | { op: 'asyncAnswer'; pane: string; question: string; option?: string; text?: string }
  /**
   * The whole of the Claude Code permission dialog that asks `question` in `episode` (`InboxEntry.episode`), read
   * off the terminal by paging its view up and back (a preview taller than the pane shows only its end):
   * `{text, episode}`, from the title to the question. Fails with `stale_dialog` when the pane shows another
   * episode or question, `not_permission` for any other dialog, `not_revealed` when its top was not reached.
   * The view is paged once per episode: a repeat in the same episode gets the same text.
   */
  | { op: 'revealDialog'; pane: string; question: string; episode: string }
  | { op: 'keys'; pane: string; keys: string[] }
  | { op: 'interrupt'; pane: string; last?: string }
  /** `/goal clear`; a working agent is interrupted first (`last` as for `interrupt`). */
  | { op: 'clearGoal'; pane: string; last?: string }
  | { op: 'ack' | 'seen' | 'unack' | 'focus'; pane: string }
  | { op: 'snooze'; pane: string; minutes?: number }
  | { op: 'dismissFirstMessage'; pane: string }
  | { op: 'fork'; pane: string; mode?: ForkMode; at?: string; request?: RequestId }

/**
 * A client-generated id (letters, digits, `_.-`, at most 64) for one `new` or `fork` click: a request that
 * repeats one still running, or one that succeeded within the last 30 s, gets that first result back
 * (`{pane}`) instead of creating another tab.
 */
export type RequestId = string

/**
 * Every JSON response: `{ ok: true, ...data }` or `{ ok: false, error, code }`. `/api/*` needs
 * `Authorization: Bearer <token>` and answers `401 {code: 'unauthorized'}` without it; `GET /api/session`
 * just checks the token.
 */
export type Result<T extends object = object> =
  | ({ ok: true } & T)
  | {
      ok: false
      error: string
      code: string
      /** With `terminal_draft`: the text waiting in the agent's input box. */
      draft?: string
    }

/** A subscription limit: the 5-hour session or the week, of the whole plan or of one model. */
export interface UsageWindow {
  kind: 'session' | 'week'
  /** The model a limit of its own applies to (`Opus`); null for the plan's. */
  scope: string | null
  usedPercent: number
  resetsAt: string | null
}

/** GET /api/usage: each Claude Code and Codex sign-in on the server's machine, and its limits. */
export interface UsageAccount {
  provider: 'claude' | 'codex'
  /** The account's email, when the sign-in names it. */
  label: string | null
  plan: string | null
  windows: UsageWindow[]
  problem?: 'expired' | 'rate_limited' | 'failed'
}

export interface UsageReport {
  accounts: UsageAccount[]
}
