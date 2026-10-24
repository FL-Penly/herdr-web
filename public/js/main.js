import { checkToken, connectStateSocket } from './api.js'
import { initAttachments } from './attachments.js'
import {
  TOKEN_KEY,
  clearToken,
  linkUsable,
  markSpent,
  onUnauthorized,
  storeToken,
  storedToken,
  takeLoginFromAddress,
  takeTokenFromUrl,
  tokenChange,
} from './auth.js'
import { initCards, renderLive } from './cards.js'
import { refreshTimes, startClock } from './clock.js'
import { appendToDraft, initComposer, renderComposer } from './composer.js'
import { $, isNarrow } from './dom.js'
import { initBackButton } from './gestures.js'
import { initHome, renderHome } from './home.js'
import { applyI18n, initLocale } from './i18n/dom.js'
import { t } from './i18n/index.js'
import { initMenus } from './menus.js'
import { needList } from './model.js'
import {
  currentView,
  goHome,
  initNavigation,
  isHomeOpen,
  isPaneViewOpen,
  markSeenSoon,
  renderBar,
  selectPane,
  setView,
} from './navigation.js'
import { initNotifications, notifyAgent } from './notify.js'
import { initPalette } from './palette.js'
import { initPaneMenus } from './pane-menu.js'
import { followPanelTerminal, initPanelTerminal } from './panel-term.js'
import { initReview, loadDiff, renderReview, stopDiffPolling } from './review.js'
import { initSettings } from './settings.js'
import { closeTopLayer, initShortcuts } from './shortcuts.js'
import { initSidebar, renderSidebar } from './sidebar.js'
import { initSignIn, signIn, signInWithLink } from './signin.js'
import { initSlash } from './slash.js'
import { agentBy, applyPayload, firstState, isChatPane, livePanes, state, terminalBy } from './state.js'
import { initStickyPrompt } from './sticky-prompt.js'
import { pruneDrafts } from './storage.js'
import { initTabs } from './tabs.js'
import { initTerminal, terminal } from './terminal.js'
import { initTheme } from './theme.js'
import { initThread, loadThread, renderConversation, stopThreadPolling } from './thread.js'
import { initUsage } from './usage.js'
import { initViewer } from './viewer.js'
import { initViewport } from './viewport.js'
import { initKeepAwake } from './wake.js'

const PENDING_TERMINAL_GRACE_MS = 20_000

let booted = false
let notified = new Set()

const inboxKey = agent => `${agent.pane}|${agent.inbox.reason}|${agent.since}`

function notifyNewArrivals(need) {
  if (booted) {
    for (const agent of need) {
      const viewing = agent.pane === state.selected && document.hasFocus() && currentView() === 'chat'
      // The card is already on screen when you are looking at that chat: sound only, no toast over it.
      if (!notified.has(inboxKey(agent)) && !(viewing && agent.inbox.reason === 'done')) {
        notifyAgent(agent, selectPane, { toast: !viewing })
      }
    }
  }
  notified = new Set(need.map(inboxKey))
}

function renderSummary(need) {
  document.title = (need.length ? `(${need.length}) ` : '') + 'herdr'
  const badge = $('#needs-count')
  badge.hidden = !need.length
  badge.textContent = String(need.length)
  for (const dot of document.querySelectorAll('.opener-dot')) dot.hidden = !need.length
  const label = t('nav.needsCount', { n: need.length })
  for (const button of document.querySelectorAll('[data-open-needs]')) {
    button.hidden = !need.length
    button.querySelector('.needs-opener-count').textContent = String(need.length)
    button.setAttribute('aria-label', label)
    button.title = label
  }
  const running = state.agents.filter(a => a.status === 'working').length
  $('#footer-summary').textContent = t('sidebar.summary', { n: state.agents.length, running })
}

// A freshly created pane first shows up as a plain shell; wait (briefly) until herdr reports the agent in it.
function openPendingSelection() {
  const pending = state.pendingSelect
  if (!pending) return
  const ready =
    isChatPane(pending.pane) ||
    (terminalBy(pending.pane) && (!pending.agent || Date.now() - pending.at > PENDING_TERMINAL_GRACE_MS))
  if (!ready) return
  state.pendingSelect = null
  selectPane(pending.pane)
}

function onState(payload) {
  applyPayload(payload)
  pruneDrafts(livePanes())
  const need = needList(state.agents)
  notifyNewArrivals(need)
  booted = true
  renderSummary(need)
  openPendingSelection()
  if (state.selected && state.selectedIsTerminal && isPaneViewOpen() && isChatPane(state.selected)) {
    selectPane(state.selected)
  }
  renderSidebar()
  followPanelTerminal()
  if (state.selected && isPaneViewOpen()) {
    renderBar()
    if (currentView() === 'chat') {
      const status = agentBy(state.selected)?.status
      const flipped = status !== state.lastStatus && (status === 'working' || state.lastStatus === 'working')
      if (state.thread && flipped) renderConversation()
      state.lastStatus = status
      renderLive()
      renderComposer()
      markSeenSoon()
    }
  }
  if (isHomeOpen()) renderHome()
}

function renderAll() {
  renderSidebar()
  if (isPaneViewOpen()) {
    renderBar()
    renderConversation()
    renderLive()
    renderComposer()
    terminal.renderStatus()
    if (state.reviewOpen) renderReview()
  } else renderHome()
  renderSummary(needList(state.agents))
  refreshTimes(document)
}

function onConnection(connected) {
  const dot = $('#conn')
  dot.classList.toggle('is-online', connected)
  const label = connected ? t('conn.online') : t('conn.offline')
  dot.setAttribute('aria-label', label)
  dot.title = label
}

// A notification tapped while no window was open starts the app at /?pane=<id>.
function paneFromUrl() {
  const url = new URL(location.href)
  const pane = url.searchParams.get('pane')
  if (!pane) return null
  url.searchParams.delete('pane')
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  return pane
}

// Whether the page was reached through Back/Forward rather than opened (null when the browser cannot tell).
function loadedByTraversal() {
  const entry = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType?.('navigation')[0])
  return entry ? entry.type === 'back_forward' : null
}

// A login link (`#t=…` from `bun run url`, or an older `?t=…`) signs in once and is then dropped from the address.
async function authenticate(linkToken) {
  const usable = linkToken && linkUsable(linkToken, loadedByTraversal()) ? linkToken : ''
  const token = usable || storedToken()
  // With HERDR_WEB_TOKEN=off the server takes no token at all, so '' is checked too.
  if ((await checkToken(token)) === 'unauthorized') {
    await signIn({ error: token ? 'signin.wrong' : '' })
    return
  }
  if (usable) storeToken(usable)
}

let stateSocket = null
let signingIn = null
// The token the open sockets were made with, to tell another tab's sign-out or sign-in from this tab's own.
let heldToken = ''

function stopEverything() {
  stateSocket?.stop()
  stopThreadPolling()
  stopDiffPolling()
  terminal.detach()
}

function resume() {
  signingIn = null
  heldToken = storedToken()
  stateSocket?.start()
  if (!state.selected || !isPaneViewOpen()) return
  loadDiff()
  if (currentView() === 'chat') loadThread(true)
  else terminal.attach(state.selected)
}

function suspend(error) {
  if (signingIn) return
  stopEverything()
  signingIn = signIn({ error }).then(resume)
}

function signOut() {
  markSpent(storedToken())
  clearToken()
  suspend('')
}

// Signing out in one tab signs every tab out at once, sockets included; a new token elsewhere reconnects with it.
function onStorage(event) {
  const change = tokenChange(event, heldToken)
  if (!change) return
  if (change.kind === 'signedOut') {
    markSpent(heldToken)
    heldToken = ''
    return suspend('')
  }
  // Still at the sign-in view (or the first check): the new token signs this tab in too.
  if (signingIn || !stateSocket) return signInWithLink(change.token, suspend)
  stopEverything()
  resume()
}

async function boot() {
  // Before anything else touches history: the Back button's extra entry must not copy the token.
  const linkToken = takeLoginFromAddress()
  const linked = paneFromUrl()
  initViewport()
  initLocale()
  initTheme()
  applyI18n(document)
  initMenus()
  initNavigation()
  initSidebar()
  initTabs()
  initThread()
  initCards()
  initComposer()
  initAttachments()
  initSlash()
  initReview()
  initHome()
  initPalette()
  initPaneMenus()
  initTerminal()
  initViewer()
  initStickyPrompt()
  initKeepAwake()
  initUsage()
  initPanelTerminal()
  // Text quoted from the terminal goes into the message being written, in the chat.
  document.addEventListener('herdr:quote', e => {
    setView('chat')
    appendToDraft(/** @type {CustomEvent<string>} */ (e).detail)
  })
  initShortcuts()
  initSettings({ onLocaleChange: renderAll, onSignOut: signOut })
  initNotifications(selectPane)
  if (isNarrow()) initBackButton(closeTopLayer)
  initSignIn()
  onConnection(false)
  startClock()
  // The Navigation API tells a fragment typed or opened (push) from one reached by Back (traverse).
  let traversal = /** @type {boolean | null} */ (null)
  window.navigation?.addEventListener('navigate', e => {
    traversal = e.navigationType === 'traverse'
  })
  window.addEventListener('hashchange', () => {
    const link = takeTokenFromUrl(location.href)
    if (link.token === null) return
    history.replaceState(history.state, '', link.url)
    if (linkUsable(link.token, traversal)) signInWithLink(link.token, suspend)
  })
  window.addEventListener('storage', e => {
    if (e.storageArea === localStorage && (e.key === null || e.key === TOKEN_KEY)) onStorage(e)
  })
  await authenticate(linkToken)
  heldToken = storedToken()
  stateSocket = connectStateSocket(onState, onConnection)
  onUnauthorized(() => suspend('signin.expired'))
  stateSocket?.start()
  await firstState
  if (linked && (agentBy(linked) || terminalBy(linked))) state.selected = linked
  if (state.selected && (agentBy(state.selected) || terminalBy(state.selected))) selectPane(state.selected)
  else goHome()
}

boot()
