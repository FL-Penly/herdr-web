// @ts-check
import { isAgentKind } from './model.js'
import { load } from './storage.js'

/** @typedef {import('../../src/protocol.ts').AgentView} AgentView */
/** @typedef {import('../../src/protocol.ts').TerminalView} TerminalView */
/** @typedef {import('../../src/protocol.ts').TabView} TabView */
/** @typedef {import('../../src/protocol.ts').WorkspaceView} WorkspaceView */
/** @typedef {import('../../src/protocol.ts').Layout} Layout */
/** @typedef {import('../../src/protocol.ts').Thread} Thread */
/** @typedef {import('../../src/protocol.ts').Diff} Diff */
/** @typedef {import('../../src/protocol.ts').StatePayload} StatePayload */
/** @typedef {import('../../src/protocol.ts').FirstMessage} FirstMessage */
/** @typedef {import('../../src/protocol.ts').ReplyQueue} ReplyQueue */

/**
 * A message sent but not yet in the transcript: drawn as a faded bubble until the thread has more turns than `total`.
 * @typedef {{ id?: string; pane: string; text: string; total: number; at: number; starting?: string }} PendingMessage
 * @typedef {{ pane: string; command: string; text: string | null }} CommandOutput
 * @typedef {{ pane: string; agent: boolean; at: number }} PendingSelect
 * @typedef {'chat' | 'term'} View
 * @typedef {'claude' | 'codex' | 'shell'} HomeAgent
 */

export const state = {
  /** @type {AgentView[]} */ agents: [],
  /** @type {TerminalView[]} */ terminals: [],
  /** @type {TabView[]} */ tabs: [],
  /** @type {WorkspaceView[]} */ workspaces: [],
  /** @type {Layout[]} */ layouts: [],
  /** @type {FirstMessage[]} */ firstMessages: [],
  /** @type {ReplyQueue[]} */ replyQueues: [],
  home: '',

  /** @type {string | null} */ selected: load('selected', null),
  selectedIsTerminal: false,
  /** @type {View} */ preferredView: load('view', 'chat'),

  needsOnly: false,
  showTerminals: load('showTerminals', false),
  /** @type {Set<string>} */ collapsed: new Set(load('collapsed', [])),
  sidebarHidden: load('sidebarHidden', false),

  /** @type {Thread | null} */ thread: null,
  threadVersion: '',
  turnLimit: 0, // set by resetThread() before a pane's first load
  prependPending: false,
  /** @type {Map<string, boolean>} */ toolOpen: new Map(),
  /** @type {Map<string, boolean>} */ turnOpen: new Map(),
  /** @type {Set<string>} */ userExpanded: new Set(),
  /** @type {string | null | undefined} */ lastStatus: undefined,
  /** @type {PendingMessage | null} */ pendingMessage: null,
  /** @type {CommandOutput | null} */ commandOutput: null,
  /** @type {{ id: string; pane: string; text: string } | null} */ lastSent: null,
  /** @type {PendingSelect | null} */ pendingSelect: null,

  /** @type {Diff | null} */ diff: null,
  diffSignature: '',
  reviewOpen: false,
  /** @type {string | null} */ reviewFile: null,

  /** The workspace picked for a new session; null works it out from the folder. */
  /** @type {string | null} */ homeWorkspace: null,
  /** A new workspace's name, when one was asked for. */
  /** @type {string | null} */ homeNewName: null,
  /** The folder picked for a new session ('' before one is). */
  homeDir: /** @type {string} */ (load('homeDir', '')),
  /** @type {HomeAgent} */ homeAgent: load('homeAgent', 'claude'),

  /** @type {{ reply: string[]; home: string[] }} */ attachments: { reply: [], home: [] },
  sound: load('sound', true),
}

/** @type {(value: void) => void} */
let resolveFirstState = () => {}
export const firstState = new Promise(resolve => {
  resolveFirstState = resolve
})

/** @param {StatePayload} payload */
export function applyPayload(payload) {
  state.agents = payload.agents ?? []
  state.terminals = payload.terminals ?? []
  state.tabs = payload.tabs ?? []
  state.workspaces = payload.workspaces ?? []
  state.layouts = payload.layouts ?? []
  state.home = payload.home ?? ''
  state.firstMessages = payload.firstMessages ?? []
  state.replyQueues = payload.replyQueues ?? []
  const pending = state.pendingMessage
  if (pending?.starting && state.firstMessages.some(m => m.pane === pending.pane && m.status === 'failed')) {
    state.pendingMessage = null
  }
  resolveFirstState()
}

/** @param {string | null | undefined} pane */
export const firstMessageFor = pane => state.firstMessages.find(m => m.pane === pane) ?? null
/** @param {string | null | undefined} pane */
export const agentBy = pane => state.agents.find(a => a.pane === pane)
/** @param {string | null | undefined} pane */
export const terminalBy = pane => state.terminals.find(t => t.pane === pane)
/** @param {string | null | undefined} id */
export const workspaceBy = id => state.workspaces.find(w => w.id === id)
export const selectedAgent = () => agentBy(state.selected)
/** @param {string | null | undefined} pane */
export const isChatPane = pane => isAgentKind(agentBy(pane)?.kind)

export function livePanes() {
  return new Set([...state.agents.map(a => a.pane), ...state.terminals.map(t => t.pane)])
}
