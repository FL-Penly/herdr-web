import { sendAction } from './api.js'
import { cancelUploads, renderAttachments } from './attachments.js'
import { renderLive } from './cards.js'
import { loadDraft, renderComposer } from './composer.js'
import { $, esc, icon, isNarrow, setHtml } from './dom.js'
import { renderHome } from './home.js'
import { t } from './i18n/index.js'
import { terminalLabel } from './labels.js'
import { closeMenu } from './menus.js'
import { agentTitle, isAgentKind, isDone, statusDotClass } from './model.js'
import { loadDiff, setReviewOpen } from './review.js'
import { closeDrawer, renderSidebar, statusLabel } from './sidebar.js'
import { agentBy, isChatPane, selectedAgent, state, terminalBy, workspaceBy } from './state.js'
import { save } from './storage.js'
import { renderTabs } from './tabs.js'
import { terminal } from './terminal.js'
import { loadThread, resetThread, restoreReadingPosition, saveReadingPosition, stopThreadPolling } from './thread.js'

export const isPaneViewOpen = () => !$('#pane-view').hidden
export const isHomeOpen = () => !$('#home-view').hidden
export const currentView = () => ($('#terminal-view').hidden ? 'chat' : 'term')

export function selectPane(pane) {
  const agent = agentBy(pane)
  if (!agent && !terminalBy(pane)) return
  closeMenu()
  const changed = state.selected !== pane || !isPaneViewOpen()
  state.selected = pane
  state.selectedIsTerminal = !isAgentKind(agent?.kind)
  save('selected', pane)
  closeDrawer()
  $('#home-view').hidden = true
  $('#pane-view').hidden = false
  if (changed) {
    resetThread()
    state.diff = null
    state.diffSignature = ''
    state.reviewFile = null
    state.attachments.reply = []
    cancelUploads('reply')
    renderAttachments('reply')
    loadDraft(pane)
    terminal.detach()
  }
  setView(state.selectedIsTerminal ? 'term' : state.preferredView, false)
  renderSidebar()
  renderBar()
  loadDiff()
}

export function goHome() {
  if (isPaneViewOpen() && currentView() === 'chat') saveReadingPosition()
  closeMenu()
  state.selected = null
  save('selected', null)
  terminal.detach()
  stopThreadPolling()
  closeDrawer()
  $('#pane-view').hidden = true
  $('#home-view').hidden = false
  setReviewOpen(false)
  renderSidebar()
  renderHome()
  setTimeout(() => $('#home-text').focus(), 30)
}

export function setView(view, remember = true) {
  const chatPane = isChatPane(state.selected)
  const next = view === 'chat' && !chatPane ? 'term' : view
  // The conversation is hidden from here on; take the reading position while it can still be measured.
  if (next === 'term' && currentView() === 'chat' && isPaneViewOpen()) saveReadingPosition()
  else if (next === 'chat' && currentView() === 'term') restoreReadingPosition()
  if (remember && chatPane) {
    state.preferredView = next
    save('view', next)
  }
  $('#pane-view').classList.toggle('is-terminal', next === 'term')
  $('#conversation').hidden = next !== 'chat'
  $('#terminal-view').hidden = next !== 'term'
  $('#view-switch').hidden = !chatPane
  for (const button of $('#view-switch').querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === next))
  }
  if (next === 'term') {
    stopThreadPolling()
    if (terminal.pane !== state.selected) terminal.attach(state.selected)
    // On a phone the keyboard would cover half the terminal; the key row's keyboard button brings it up.
    setTimeout(() => {
      if (!isNarrow()) terminal.focus()
    }, 50)
  } else {
    terminal.detach()
    loadThread(true)
    renderComposer()
    renderLive()
    setTimeout(() => {
      if (!isNarrow()) $('#reply-text').focus()
    }, 30)
  }
}

export function toggleView() {
  if (state.selected && isPaneViewOpen()) setView(currentView() === 'chat' ? 'term' : 'chat')
}

export function renderBar() {
  renderTabs()
  const agent = agentBy(state.selected)
  const term = terminalBy(state.selected)
  const pane = agent || term
  const title = $('#pane-title')
  const crumb = $('#pane-crumb')
  const sub = $('#pane-sub')
  if (!pane) {
    title.textContent = t('pane.ended')
    setHtml(crumb, '')
    sub.textContent = ''
    return
  }
  const workspace = workspaceBy(pane.workspace)
  const workspaceLabel = workspace?.label ?? agent?.workspaceLabel ?? ''
  const name = agent ? agentTitle(agent) : terminalLabel(term, state.home)
  if (title.textContent !== name) title.textContent = name
  setHtml(
    crumb,
    `<span>${icon('folder')}${esc(workspaceLabel)}</span>` +
      (agent?.branch ? `<span>${icon('branch')}${esc(agent.branch.name)}</span>` : ''),
  )
  const status = agent && isAgentKind(agent.kind) ? statusLabel(agent) : t('home.terminal')
  const subText = [status, workspaceLabel].filter(Boolean).join(' · ')
  if (sub.textContent !== subText) sub.textContent = subText
  const dot = agent ? statusDotClass(agent) : ''
  sub.classList.toggle('is-working', dot.includes('running'))
  sub.classList.toggle('is-needs', dot.includes('needs'))
  const diff = state.diff
  const button = $('#diff-btn')
  if (diff?.files.length) {
    button.hidden = false
    setHtml(button, `<span class="diff-add">+${diff.added}</span><span class="diff-del">−${diff.removed}</span>`)
    button.setAttribute('aria-pressed', String(state.reviewOpen))
  } else button.hidden = true
}

let seenTimer = null
const SEEN_REASONS = ['done', 'question']

/**
 * A finished reply this view can mark read: one in the inbox, or one herdr still calls done.
 * @param {import('./model.js').AgentView | null | undefined} agent
 */
const unread = agent => !!agent && ((!!agent.inbox && SEEN_REASONS.includes(agent.inbox.reason)) || isDone(agent))

// A finished reply counts as read once it has been on screen for a moment.
export function markSeenSoon() {
  if (!unread(selectedAgent()) || seenTimer) return
  seenTimer = setTimeout(() => {
    seenTimer = null
    const current = selectedAgent()
    const visible = document.hasFocus() && currentView() === 'chat' && isPaneViewOpen()
    if (current && unread(current) && visible) {
      sendAction({ op: 'seen', pane: current.pane }).catch(() => {})
    }
  }, 1500)
}

export function initNavigation() {
  $('#view-switch').addEventListener('click', e => {
    const button = e.target.closest('[data-view]')
    if (button) setView(button.dataset.view)
  })
  window.addEventListener('focus', () => {
    if (state.selected) markSeenSoon()
  })
}
