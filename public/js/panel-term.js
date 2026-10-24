// @ts-check
import { postAction } from './api.js'
import { $ } from './dom.js'
import { currentView, setView } from './navigation.js'
import { agentBy, state } from './state.js'

// A command that only fails (unknown command, wrong state) never hides the input box: back after this long.
const SETTLE_MS = 4000

/**
 * The terminal shown for a panel command: back to the chat once the panel has closed.
 * @type {{ pane: string; command: string; at: number; panel: boolean } | null}
 */
let open = null
let settleTimer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined)

function render() {
  const note = $('#term-panel')
  note.hidden = !open
  if (open) $('[data-panel-command]', note).textContent = open.command
}

/**
 * Show the terminal for `command`, which opens a panel in `pane`.
 * @param {string} pane
 * @param {string} command
 */
export function showPanelTerminal(pane, command) {
  if (state.selected !== pane) return
  open = { pane, command, at: Date.now(), panel: false }
  setView('term', false)
  render()
  // The state only updates when something changed: look again once the command has had its time.
  clearTimeout(settleTimer)
  settleTimer = setTimeout(followPanelTerminal, SETTLE_MS + 100)
}

/** On every state update: the panel is open while the agent's input box is off screen, closed once it is back. */
export function followPanelTerminal() {
  if (!open) return
  if (state.selected !== open.pane || currentView() !== 'term') {
    open = null
    return render()
  }
  const agent = agentBy(open.pane)
  if (agent?.inputBox === false) open.panel = true
  else if (agent?.inputBox && (open.panel || Date.now() - open.at > SETTLE_MS)) {
    open = null
    clearTimeout(settleTimer)
    setView('chat', false)
  }
  render()
}

// Back to the chat while the panel may still be open: the panel closes in the pane too, or the next message sent
// from the chat would be typed into it. Asked whatever the last state said, which can lag the panel by a second:
// the server reads the screen and presses nothing when the input box is there.
function leaveForChat() {
  const pane = open?.pane
  open = null
  clearTimeout(settleTimer)
  render()
  if (pane) void postAction({ op: 'closePanel', pane })
}

export function initPanelTerminal() {
  $('#term-panel').addEventListener('click', e => {
    const action = /** @type {HTMLElement} */ (e.target)
      .closest('[data-panel]')
      ?.getAttribute('data-panel')
    if (!action) return
    if (action === 'chat') {
      leaveForChat()
      return setView('chat', false)
    }
    open = null
    render()
  })
  // Before the view switch's own handler, while the panel is still known.
  $('#view-switch').addEventListener(
    'click',
    e => {
      const view = /** @type {HTMLElement} */ (e.target)
        .closest('[data-view]')
        ?.getAttribute('data-view')
      if (view === 'chat' && open) leaveForChat()
    },
    true,
  )
}
