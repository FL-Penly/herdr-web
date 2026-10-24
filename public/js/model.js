// @ts-check
import { prettyModel, terminalTitle, uploadParts } from './format.js'

/** @typedef {import('../../src/protocol.ts').AgentView} AgentView */
/** @typedef {import('../../src/protocol.ts').TerminalView} TerminalView */
/** @typedef {import('../../src/protocol.ts').TabView} TabView */
/** @typedef {import('../../src/protocol.ts').InboxEntry} InboxEntry */
/** @typedef {import('../../src/protocol.ts').Option} Option */
/** @typedef {import('../../src/protocol.ts').Item} Item */
/** @typedef {import('../../src/protocol.ts').ToolItem} ToolItem */
/** @typedef {import('../../src/protocol.ts').Turn} Turn */
/** @typedef {import('../../src/protocol.ts').Command} Command */
/** @typedef {import('../../src/protocol.ts').Model} Model */
/** @typedef {import('../../src/protocol.ts').ModelCatalog} ModelCatalog */
/** @typedef {import('../../src/protocol.ts').WorkspaceView} WorkspaceView */

/** @type {Record<string, { label: string; short: string }>} */
const AGENT_KINDS = {
  claude: { label: 'Claude Code', short: 'CC' },
  codex: { label: 'Codex', short: 'CX' },
}

/** @param {string | null | undefined} kind */
export const isAgentKind = kind => kind === 'claude' || kind === 'codex'
/** @param {string} kind */
export const kindLabel = kind => AGENT_KINDS[kind]?.label ?? kind
/** @param {string} kind */
export const kindShort = kind => AGENT_KINDS[kind]?.short ?? kind.slice(0, 2).toUpperCase()

/** @param {AgentView} agent */
export const agentTitle = agent => agent.title || kindLabel(agent.kind)

/**
 * Menus and panels the user opened themselves (`/model`, `/status`) are shown as cards but never count as waiting.
 * @param {InboxEntry | null | undefined} inbox
 */
export const isUserOpened = inbox => inbox?.source === 'menu' || inbox?.source === 'panel'

/**
 * Agents that want attention: unsnoozed, not user-opened menus; open questions first, finished ones last.
 * @param {AgentView[]} agents
 * @param {number} [now]
 */
export function needList(agents, now = Date.now()) {
  return agents
    .filter(a => a.inbox && !isUserOpened(a.inbox) && !((a.inbox.snoozedUntil ?? 0) > now))
    .sort((a, b) => Number(a.inbox?.reason === 'done') - Number(b.inbox?.reason === 'done') || a.since - b.since)
}

/**
 * An agent waits on the user: herdr says it is blocked, or its inbox entry asks something.
 * @param {AgentView} agent
 */
const waitsOnUser = agent => agent.status === 'blocked' || (!!agent.inbox && agent.inbox.reason !== 'done')

/**
 * A finished turn: herdr says done (until the pane is focused in herdr), or its inbox entry is a finished reply.
 * Reading the reply here takes it out of the inbox, but herdr cannot be told, so the dot keeps saying what
 * herdr says.
 * @param {AgentView} agent
 */
export const isDone = agent => agent.status === 'done' || agent.inbox?.reason === 'done'

/** @param {AgentView | null | undefined} agent */
export function statusDotClass(agent) {
  if (!agent) return 'dot'
  if (agent.status === 'working') return 'dot dot-running'
  if (waitsOnUser(agent)) return 'dot dot-needs'
  if (isDone(agent)) return 'dot dot-done'
  return 'dot'
}

/**
 * Background shells a finished Claude Code turn left running: it says so under the turn
 * (`done · 1 shell still running`), and the turn is done all the same.
 * @param {AgentView | null | undefined} agent
 */
export const shellsAfterTurn = agent =>
  agent && agent.status !== 'working' && agent.status !== 'blocked' ? agent.shells : 0

// Commands whose whole point is a panel or a picker drawn in the terminal (settings, permissions, sign-in): a
// chat card cannot stand in for them, so sending one shows the terminal until the panel closes.
const PANEL_COMMANDS = {
  claude: new Set([
    '/config',
    '/settings',
    '/permissions',
    '/allowed-tools',
    '/theme',
    '/agents',
    '/mcp',
    '/hooks',
    '/memory',
    '/plugin',
    '/plugins',
    '/output-style',
    '/status',
    '/usage',
    '/stats',
    '/doctor',
    '/ide',
    '/login',
    '/logout',
    '/privacy-settings',
    '/terminal-setup',
    '/export',
    '/vim',
  ]),
  codex: new Set(['/approvals', '/permissions', '/theme', '/settings', '/feedback', '/logout', '/experimental']),
}

/**
 * Whether `command` (`/config`, the first word of what was sent) opens a panel the chat cannot show.
 * @param {string | null | undefined} kind
 * @param {string} command
 */
export const opensInTerminal = (kind, command) =>
  !!kind && kind in PANEL_COMMANDS && PANEL_COMMANDS[/** @type {'claude' | 'codex'} */ (kind)].has(command)

/**
 * The collapsed workspaces after "collapse all / expand all": all of `shown` collapse while any is open, else
 * all open. Workspaces not shown keep their state.
 * @param {Set<string>} collapsed
 * @param {string[]} shown
 */
export function toggleAllGroups(collapsed, shown) {
  const next = new Set(collapsed)
  const anyOpen = shown.some(id => !collapsed.has(id))
  for (const id of shown) {
    if (anyOpen) next.add(id)
    else next.delete(id)
  }
  return next
}

/**
 * The agent whose state best represents a group: working, then waiting on you, then finished.
 * @param {AgentView[]} agents
 */
export function pickHottest(agents) {
  return (
    agents.find(a => a.status === 'working') ||
    agents.find(waitsOnUser) ||
    agents.find(a => a.inbox || isDone(a)) ||
    null
  )
}

/** herdr's automatic tab labels; anything else was named by the user and wins over the agent title. */
const DEFAULT_TAB_LABEL = /^(\d+|claude|codex|shell|fork)$/i

/**
 * @param {TabView} tab
 * @param {{ agentBy: (pane: string) => AgentView | undefined; terminalBy: (pane: string) => TerminalView | undefined; home: string }} lookup
 * @returns {{ main: string; name: string; agent: AgentView | null }} `name` is '' for an untitled shell
 */
export function tabInfo(tab, { agentBy, terminalBy, home }) {
  const agents = /** @type {AgentView[]} */ (tab.panes.map(agentBy).filter(Boolean))
  const main = agents.find(a => isAgentKind(a.kind))?.pane || tab.panes[0]
  const mainAgent = agentBy(main)
  const name = !DEFAULT_TAB_LABEL.test(tab.label.trim())
    ? tab.label
    : mainAgent
      ? agentTitle(mainAgent)
      : terminalTitle(terminalBy(main), home)
  const busy = pickHottest(agents) || mainAgent
  return { main, name, agent: busy && isAgentKind(busy.kind) ? busy : null }
}

/** @param {string} label */
export const isFreeTextOption = label => /^(Other|Type something|None of the above|其他)/i.test(label)
/** @param {string} label */
export const isAffirmative = label => /^(yes|allow|允许|是)/i.test(label)

/**
 * The digit shown next to an option: its own key for numbered dialogs, else its position.
 * @param {Option} option
 * @param {number} index
 */
export const optionShortcut = (option, index) => (/^\d+$/.test(option.key) ? option.key : String(index + 1))

/**
 * Which option a digit key picks: the numbered one, or the n-th entry of an arrow-key menu.
 * @param {Option[]} options
 * @param {string} digit
 */
export function optionForDigit(options, digit) {
  if (!options.length) return null
  return (
    options.find(o => o.key === digit) ||
    (options[0].key.startsWith('nav:') ? options[Number(digit) - 1] : null) ||
    null
  )
}

/**
 * Picks `option` of the dialog that was on screen. The server checks the label (and the question) against the
 * dialog it sees now and refuses with `stale_dialog` when it changed, so a late click cannot land elsewhere.
 * @param {string} pane
 * @param {{ question?: string }} dialog
 * @param {Option} option
 * @param {string} [text] the free-text answer for an "Other" option
 */
export function optionAction(pane, dialog, option, text) {
  return {
    op: /** @type {const} */ ('option'),
    pane,
    key: option.key,
    label: option.label,
    // An empty question is still checked: the server skips the check only when none is sent.
    ...(typeof dialog.question === 'string' ? { question: dialog.question } : {}),
    ...(text ? { text } : {}),
  }
}

/**
 * What a dialog or question card is keyed by in the live area: a card with the same key keeps its DOM, so a
 * half-typed answer survives unrelated updates (a new activity, a timer).
 * @param {{ call?: string; title?: string; reason?: string; question?: string }} card
 */
export const cardKey = card =>
  card.call !== undefined
    ? `ask:${card.call}|${card.title ?? ''}`
    : `dialog:${card.reason ?? ''}|${card.question ?? ''}`

/**
 * The history controls above a thread: how many more turns "Load more" fetches (0: no button) and whether
 * to say that older history is out of reach (dropped by the server's limits, or past `maxTurns`).
 * @param {{ more: number; meta: { truncated?: boolean; maxTurns?: number } }} thread
 * @param {number} limit the turns requested so far
 * @param {number} page
 */
export function historyControls(thread, limit, page) {
  const max = thread.meta.maxTurns ?? Number.POSITIVE_INFINITY
  const available = Math.min(thread.more, Math.max(0, max - limit))
  const loadMore = Math.min(available, page)
  return {
    loadMore,
    available,
    nextLimit: limit + loadMore,
    unavailable: !loadMore && (thread.more > 0 || !!thread.meta.truncated),
  }
}

const DIALOG_REASONS = ['permission', 'choice', 'blocked', 'trust']

/**
 * Whether the agent shows a dialog card. A Codex async-question panel without options is answered by the question card instead.
 * @param {AgentView | null | undefined} agent
 * @param {number} pendingAsks
 */
export function showsDialogCard(agent, pendingAsks) {
  const inbox = agent?.inbox
  if (!inbox || !DIALOG_REASONS.includes(inbox.reason)) return false
  return !(pendingAsks && !inbox.options.length)
}

/** @param {AgentView | null | undefined} agent */
export const hasBlockingDialog = agent => agent?.status === 'blocked' && !!agent.inbox?.options.length

/** What `herdr agent rename` accepts. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

export const INTERRUPTED_RE = /^\[Request interrupted by user[^\]]*\]$/

/** @param {string} text */
export const isLongUserText = text => text.length > 900 || text.split('\n').length > 14

/** @param {Turn} turn */
export function lastReplyText(turn) {
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    const step = turn.steps[i]
    if (step.type === 'text') return step.text
  }
  return ''
}

/** @param {Command} command */
export function commandSourceKey(command) {
  if (command.origin === 'builtin') return 'builtin'
  if (command.origin === 'plugin') return 'plugin'
  if (command.origin === 'project') return 'project'
  return command.type === 'skill' ? 'skill' : 'command'
}

/** @param {string} id */
const normalizeModelId = id => id.toLowerCase().replace(/\[\w+\]$/, '')

/**
 * The catalog entry the agent runs now, from the status line label and/or the transcript's model id.
 * @param {Model[]} models
 * @param {{ statusModel?: string | null; transcriptModel?: string | null }} current
 */
export function currentModel(models, { statusModel, transcriptModel }) {
  if (transcriptModel) {
    const id = normalizeModelId(transcriptModel)
    const exact = models.find(m => m.id && m.id === transcriptModel)
    if (exact) return exact
    const loose = models.find(m => m.id && (normalizeModelId(m.id) === id || id.includes(normalizeModelId(m.id))))
    if (loose && !statusModel) return loose
  }
  if (statusModel) {
    const label = statusModel.toLowerCase()
    return models.find(m => m.id && label.startsWith(m.label.toLowerCase().replace(/ \(1m\)$/, ''))) ?? null
  }
  return null
}

/**
 * @param {string | null | undefined} id
 * @param {ModelCatalog | null | undefined} catalog
 */
export function modelLabel(id, catalog) {
  if (!id) return ''
  return catalog?.models.find(m => m.id === id)?.label ?? prettyModel(id)
}

/**
 * Resolves the home screen's remembered pick against the catalog. `model: ''` means the agent's default;
 * `modelId` and `pickedEffort` (what gets sent) are '' unless the pick still exists in the catalog.
 * @param {ModelCatalog} catalog
 * @param {{ model?: string; effort?: string }} pick
 */
export function resolveModelPick(catalog, pick) {
  const wanted = pick.model ?? catalog.default.model
  const model =
    catalog.models.find(m => m.id === wanted) || catalog.models.find(m => !m.id) || catalog.models[0] || null
  const defaultEffort = model?.effort || catalog.default.effort || ''
  const efforts = model?.efforts.length ? model.efforts : catalogEfforts(catalog)
  const pickedEffort = pick.effort && efforts.includes(pick.effort) ? pick.effort : ''
  return {
    model,
    modelId: model?.id && model.id === pick.model ? model.id : '',
    effort: pickedEffort || defaultEffort,
    pickedEffort,
    defaultEffort,
    efforts,
  }
}

/** @param {ModelCatalog | null | undefined} catalog */
export function catalogEfforts(catalog) {
  const all = new Set(catalog?.models.flatMap(m => m.efforts) ?? [])
  return [...all]
}

const ws = /** @param {string} s */ s => s.replace(/\s+/g, ' ').trim()

/**
 * The live preview of the reply in progress (`meta.live`), or '' once the transcript has caught up with it:
 * the newest reply already starts with what the screen showed.
 * @param {{ turns: Turn[]; meta: { live?: { text: string; at: number } | null } } | null | undefined} thread
 */
export function livePreview(thread) {
  const text = thread?.meta.live?.text?.trim() ?? ''
  if (!text) return ''
  const last = thread?.turns.at(-1)
  const reply = last ? ws(lastReplyText(last)) : ''
  const head = ws(text).slice(0, 160)
  return reply.startsWith(head) ? '' : text
}

// Claude Code's file prompts end by naming the file: "Do you want to create routes.js?".
const FILE_ASK_RE = /^Do you want to (?:create|overwrite|make this edit to|edit)\s+(.+?)\s*\?$/i
// A row of the file or diff preview the TUI draws above the question: a line number, or a diff gutter.
const PREVIEW_ROW_RE = /^\s*(?:\d+\s*[+-]?(?:\s|$)|[+-]\s)/

/**
 * Whether `text` names the file `name` as a whole word: `a.js` is not named by `data.js`.
 * @param {string} text
 * @param {string} name
 */
function namesFile(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-]|\\.\\w)`).test(text)
}

/**
 * The change a permission dialog is about: an edit or command of the last turn that is still `running` and
 * that the question names. A file prompt names its file in the question line, and only that line counts: the
 * preview above it may mention other files the same message also writes. Of several running edits to that
 * file the oldest is first in line. Null when none matches, so a card never shows another tool's change.
 * @param {{ turns: Turn[] } | null | undefined} thread
 * @param {string} question
 * @returns {import('../../src/protocol.ts').ToolItem | null}
 */
export function pendingChange(thread, question) {
  /** @type {import('../../src/protocol.ts').ToolItem[]} */
  const running = []
  for (const step of thread?.turns.at(-1)?.steps ?? []) {
    // Only edits and commands have a change to review; a running plan or question is a dialog of its own.
    if (step.type === 'tool' && step.status === 'running' && (step.tool === 'edit' || step.tool === 'cmd'))
      running.push(step)
  }
  const fileName = (/** @type {{ path?: string; detail: string }} */ step) =>
    (step.path || step.detail || '').split('/').pop() ?? ''
  const { ask } = splitQuestion(question)
  const named = FILE_ASK_RE.exec(ask)?.[1]
  if (named) {
    return running.find(step => step.tool === 'edit' && fileName(step) && namesFile(named, fileName(step))) ?? null
  }
  const asked = ws(question)
  for (let i = running.length - 1; i >= 0; i--) {
    const step = running[i]
    if (step.tool === 'edit') {
      if (fileName(step) && namesFile(asked, fileName(step))) return step
      continue
    }
    const command = ws(step.detail).slice(0, 24)
    if (command && asked.includes(command)) return step
  }
  return null
}

/**
 * Whether a dialog's text is only the bottom of a change the TUI could not fit on screen: it opens on a row
 * of the file or diff preview instead of the dialog's title ("Create file", "Bash command", …), so its top
 * (the title, the file's first lines) is cut off.
 * @param {string} question
 */
export function isCutPreview(question) {
  const { preview } = splitQuestion(question)
  const first = preview.split('\n').find(line => line.trim())
  return !!first && PREVIEW_ROW_RE.test(first)
}

/**
 * Whether a permission card has only the end of the change it asks about, so the rest is read off Claude Code's
 * terminal (`revealDialog`): Codex's screen does not page, and a change the transcript has is shown from there.
 * @param {{ kind: string; inbox: { reason: string; question: string; episode?: string } | null } | null | undefined} agent
 * @param {{ turns: Turn[] } | null | undefined} thread
 */
export function needsReveal(agent, thread) {
  const inbox = agent?.inbox
  return (
    agent?.kind === 'claude' &&
    inbox?.reason === 'permission' &&
    !!inbox.episode &&
    isCutPreview(inbox.question) &&
    !pendingChange(thread, inbox.question)
  )
}

/**
 * What was read off the terminal for the dialog `inbox` shows, as card `key`: the text, 'reading', 'failed', or
 * undefined when nothing was read for it. A read belongs to one episode only: two prompts in a row can show the
 * same end of a file and ask the same question about different contents.
 * @param {{ episode?: string; key: string; value: string } | undefined} stored
 * @param {{ episode?: string } | null | undefined} inbox
 * @param {string} key
 */
export function revealedText(stored, inbox, key) {
  if (!stored || !inbox?.episode || stored.episode !== inbox.episode || stored.key !== key) return undefined
  return stored.value
}

/**
 * A dialog's text split into the TUI's preview of the change (cut to what fits on screen) and the question
 * itself, its last line when that asks something.
 * @param {string} question
 */
export function splitQuestion(question) {
  const lines = String(question ?? '')
    .replace(/\s+$/, '')
    .split('\n')
  const last = lines.at(-1)?.trim() ?? ''
  if (lines.length < 2 || !/[?？]$/.test(last)) return { preview: lines.join('\n'), ask: '' }
  return { preview: lines.slice(0, -1).join('\n').replace(/\s+$/, ''), ask: last }
}

/** A click on the send button within this long after it changed what it does belongs to the earlier gesture. */
export const SEND_GUARD_MS = 600

/**
 * What the composer's send button does now. Right after a send it shows `pending` for SEND_GUARD_MS, and it
 * becomes Stop only that long after the agent is working with an empty composer, so a double click never
 * sends and then stops.
 * @param {{ working: boolean; empty: boolean; uploading: boolean; sentAt: number; stopSince: number; now: number }} s
 * @returns {'send' | 'pending' | 'uploading' | 'stop' | 'armingStop' | 'idle'}
 */
export function sendButtonMode({ working, empty, uploading, sentAt, stopSince, now }) {
  if (now - sentAt < SEND_GUARD_MS) return 'pending'
  if (uploading) return 'uploading'
  if (!empty) return 'send'
  if (!working) return 'idle'
  return now - stopSince < SEND_GUARD_MS ? 'armingStop' : 'stop'
}

/**
 * Where the reader is in a scrolled list: the first block that reaches below the top edge, and how far into it.
 * @param {{ key: string; top: number; height: number }[]} blocks tops relative to the scrolled content
 * @param {number} scrollTop
 * @returns {{ key: string; offset: number } | null}
 */
export function readingAnchor(blocks, scrollTop) {
  const block = blocks.find(b => b.top + b.height > scrollTop) ?? blocks.at(-1)
  return block ? { key: block.key, offset: scrollTop - block.top } : null
}

const CLIPPED_RE = /^… \(\d+ more chars\)$/

/**
 * The lines of a proposed change as the server sent them, and whether it cut the diff short.
 * @param {{ diff?: string; output?: string }} step
 */
export function changeLines(step) {
  const lines = String(step.diff ?? step.output ?? '')
    .replace(/\n$/, '')
    .split('\n')
  const clipped = lines.length > 0 && CLIPPED_RE.test(lines.at(-1) ?? '')
  if (clipped) lines.pop()
  return { lines: lines.length === 1 && !lines[0] ? [] : lines, clipped }
}

/** A workspace label herdr-web passes to herdr (as `/api/act` checks it): no leading space or `-`. */
export const WORKSPACE_LABEL_RE = /^[^\s\-\p{Cc}][^\p{Cc}]{0,63}$/u

/**
 * A workspace label for `dir`: its last segment, as herdr names a workspace after its folder.
 * @param {string} dir
 */
export function folderLabel(dir) {
  const name = dir.replace(/\/+$/, '').split('/').pop() ?? ''
  return name.replace(/^[\s-]+/, '').slice(0, 64) || 'workspace'
}

/**
 * Where a new session in `dir` goes: the workspace picked, else a new one named `newName`, else the first
 * workspace (in sidebar order) with a pane in that very folder, else a new workspace named after the folder.
 * A workspace in a folder above `dir` does not count: one opened in `~/projects` would take every project.
 * @param {{
 *   dir: string
 *   pick: string | null
 *   newName: string | null
 *   workspaces: WorkspaceView[]
 *   panes: { workspace: string; cwd: string }[]
 * }} o
 * @returns {{ workspace: string } | { newWorkspace: string }}
 */
export function homeTarget({ dir, pick, newName, workspaces, panes }) {
  if (pick && workspaces.some(w => w.id === pick)) return { workspace: pick }
  if (newName) return { newWorkspace: newName }
  const want = trimSlash(dir)
  const here = new Set(panes.filter(p => trimSlash(p.cwd) === want).map(p => p.workspace))
  const found = workspaces.find(w => here.has(w.id))
  return found ? { workspace: found.id } : { newWorkspace: folderLabel(want) }
}

/** @param {string} dir */
const trimSlash = dir => dir.replace(/(.)\/+$/, '$1')

/** Tools a run of steps folds into one line, as the TUIs print `Ran 3 shell commands`; edits, plans, todos and
 * questions stay on their own. */
const RUN_TOOLS = new Set(['cmd', 'read', 'search', 'web', 'task', 'skill', 'other'])

/**
 * @typedef {{ type: 'step'; step: Item; index: number }
 *   | { type: 'run'; index: number; steps: { step: ToolItem; index: number }[]; running: boolean; failed: number }} StepBlock
 */

/**
 * A turn's steps as the TUIs show them: messages, edits and the like one by one, and each run of other tool
 * calls between them as one block (thinking in between does not break a run; it is not shown).
 * @param {readonly Item[]} steps
 * @returns {StepBlock[]}
 */
export function groupSteps(steps) {
  /** @type {StepBlock[]} */
  const blocks = []
  /** @type {Extract<StepBlock, { type: 'run' }> | null} */
  let run = null
  steps.forEach((step, index) => {
    if (step.type === 'think') return
    if (step.type === 'tool' && RUN_TOOLS.has(step.tool)) {
      if (!run) {
        run = { type: 'run', index, steps: [], running: false, failed: 0 }
        blocks.push(run)
      }
      run.steps.push({ step, index })
      if (step.status === 'running') run.running = true
      if (step.status === 'error') run.failed++
      return
    }
    run = null
    blocks.push({ type: 'step', step, index })
  })
  return blocks
}

/**
 * How many of each kind a run holds, in the order they first appear: `[['cmd', 3], ['read', 2]]`.
 * @param {{ step: ToolItem }[]} steps
 * @returns {[string, number][]}
 */
export function runCounts(steps) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const { step } of steps) counts.set(step.tool, (counts.get(step.tool) ?? 0) + 1)
  return [...counts]
}

// Enough for two lines of the prompt pinned above the thread.
const PROMPT_PREVIEW = 300

/**
 * The messages the user sent in these turns, for the prompt pinned above the thread: an interruption is none of
 * theirs.
 * @param {import('../../src/protocol.ts').Turn[]} turns
 * @returns {{ id: string; preview: string }[]}
 */
export function turnPrompts(turns) {
  const found = []
  for (const turn of turns) {
    const user = turn.user
    if (!user || INTERRUPTED_RE.test(user.text.trim())) continue
    const said = user.answers?.length ? user.answers.map(a => a.answer).join(' · ') : uploadParts(user.text).text
    const text = said
      .replace(/\[Image #\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    found.push({ id: turn.id, preview: text.length > PROMPT_PREVIEW ? `${text.slice(0, PROMPT_PREVIEW - 1)}…` : text })
  }
  return found
}

/** From this share used, a limit shows red. */
export const USAGE_HOT = 80

/**
 * The limit an account's chip shows: its plan's 5-hour session, else its week, else whichever is nearest its end.
 * @param {import('../../src/protocol.ts').UsageAccount} account
 * @returns {{ window: import('../../src/protocol.ts').UsageWindow; left: number; hot: boolean } | null}
 */
export function usageChip(account) {
  const plan = account.windows.filter(w => w.scope === null)
  const window =
    plan.find(w => w.kind === 'session') ??
    plan.find(w => w.kind === 'week') ??
    [...account.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]
  if (!window) return null
  return { window, left: Math.round(100 - window.usedPercent), hot: window.usedPercent >= USAGE_HOT }
}
