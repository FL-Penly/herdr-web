import { getJson, isUnauthorized, postAction, sendAction } from './api.js'
import {
  attachmentItems,
  onAttachmentsChange,
  rememberSentImages,
  renderAttachments,
  uploadingCount,
} from './attachments.js'
import { renderLive } from './cards.js'
import { cachedModelCatalog, modelCatalog } from './catalogs.js'
import { confirmDialog, draftDialog } from './dialog.js'
import { $, autosize, esc, icon, isNarrow, isTouch, setHtml } from './dom.js'
import { embedAttachments, shortCwd, uploadParts } from './format.js'
import { t } from './i18n/index.js'
import { openMenu } from './menus.js'
import {
  SEND_GUARD_MS,
  catalogEfforts,
  currentModel,
  hasBlockingDialog,
  isUserOpened,
  modelLabel,
  opensInTerminal,
  sendButtonMode,
} from './model.js'
import { toast } from './notify.js'
import { showPanelTerminal } from './panel-term.js'
import { isMac } from './platform.js'
import { initQueue, queueReply, renderQueue } from './queue.js'
import { addFailedSend, recoverFailedSend, sendId, sendReplacingDraft } from './sends.js'
import { closeSlash } from './slash.js'
import { agentBy, selectedAgent, state } from './state.js'
import { draftFor, saveDraft } from './storage.js'
import { loadThread, renderConversation } from './thread.js'

// The TUI needs a moment to draw a slash command's output; poll the screen with growing gaps.
const COMMAND_OUTPUT_POLL_MS = [400, 400, 600, 800, 1200, 1600]
const SLASH_COMMAND_RE = /^\/[\w:-]+/

const textarea = () => $('#reply-text')

// When the last send went out, and since when the send button would stop the turn (0: it would not).
let sentAt = 0
let stopSince = 0
let guardTimer = null

/** What the send button does now; see sendButtonMode. */
function sendMode(agent = selectedAgent()) {
  const working = agent?.status === 'working'
  const empty = !textarea().value.trim() && !state.attachments.reply.length
  const uploading = uploadingCount('reply') > 0
  const wantsStop = working && empty && !uploading
  const now = Date.now()
  if (!wantsStop) stopSince = 0
  else if (!stopSince) stopSince = now
  return sendButtonMode({ working, empty, uploading, sentAt, stopSince, now })
}

const SEND_LABEL = {
  send: 'composer.send',
  pending: 'composer.sending',
  uploading: 'composer.waitingForUploadShort',
  stop: 'composer.stop',
  armingStop: 'composer.stop',
  idle: 'composer.send',
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Add a block of text (a quote) at the end of the message being written, and put the cursor after it.
 * @param {string} text
 */
export function appendToDraft(text) {
  const el = textarea()
  const before = el.value.replace(/\s+$/, '')
  el.value = `${before ? `${before}\n\n` : ''}${text}\n\n`
  autosize(el)
  if (state.selected) saveDraft(state.selected, el.value)
  renderComposer()
  el.focus()
  el.setSelectionRange(el.value.length, el.value.length)
}

export function loadDraft(pane) {
  const el = textarea()
  el.value = draftFor(pane)
  autosize(el)
}

const requestedCatalogs = new Set()

function currentCatalog(agent) {
  const catalog = cachedModelCatalog(agent.kind)
  if (!catalog && !requestedCatalogs.has(agent.kind)) {
    requestedCatalogs.add(agent.kind)
    modelCatalog(agent.kind).then(() => renderComposer())
  }
  return catalog
}

const runningModel = (agent, catalog) =>
  currentModel(catalog.models, { statusModel: agent.model, transcriptModel: state.thread?.meta.model })

export function renderComposer() {
  const agent = selectedAgent()
  if (!agent) return
  const el = textarea()
  const working = agent.status === 'working'
  const dialogOpen = hasBlockingDialog(agent)
  $('#reply-blocked').hidden = !dialogOpen
  // A phone shows one line of placeholder; the long hints would be cut mid-sentence.
  const short = isNarrow() ? 'Short' : ''
  el.placeholder = dialogOpen
    ? t(`composer.placeholderDialog${short}`)
    : working
      ? t(`composer.placeholderQueued${short}`)
      : t('composer.placeholder')
  renderQueue()
  // Codex queues behind the turn with Tab; Claude Code cannot, so the queue is ours, for both.
  const queueButton = /** @type {HTMLButtonElement} */ ($('#reply-queue-btn'))
  queueButton.hidden = !working && agent.status !== 'blocked'
  $('#reply-form').classList.toggle('can-queue', !queueButton.hidden)
  queueButton.disabled = uploadingCount('reply') > 0 || (!el.value.trim() && !state.attachments.reply.length)
  queueButton.title = t('composer.queue', { key: isMac ? '⌘↩' : 'Ctrl+Enter' })
  queueButton.setAttribute('aria-label', queueButton.title)
  const send = $('#reply-send')
  const button = sendMode(agent)
  send.classList.toggle('is-stop', button === 'stop' || button === 'armingStop')
  send.classList.toggle('is-pending', button === 'pending')
  const sendLabel = t(button === 'send' && working ? 'composer.sendQueued' : SEND_LABEL[button])
  send.setAttribute('aria-label', sendLabel)
  send.title = sendLabel
  send.disabled = button !== 'send' && button !== 'stop'
  // The guard ends on its own: draw the button's next meaning then.
  clearTimeout(guardTimer)
  if (button === 'pending' || button === 'armingStop') guardTimer = setTimeout(renderComposer, SEND_GUARD_MS)

  const meta = state.thread?.meta
  const model = agent.model || modelLabel(meta?.model, currentCatalog(agent))
  setHtml($('#reply-model'), `<span class="chip-text">${esc(model || t('composer.model'))}</span>${icon('down')}`)
  const effort = agent.effort || meta?.effort
  const effortChip = $('#reply-effort')
  effortChip.hidden = !effort && agent.kind !== 'claude'
  setHtml(
    effortChip,
    `${icon('bolt')}<span class="chip-text">${esc(effort || t('composer.effort'))}</span>${agent.ultra ? '<span class="chip-badge">ultracode</span>' : ''}${icon('down')}`,
  )
  // No mode in the footer is the default one. A tap, or Shift+Tab in the composer, moves to the next, as in the TUI.
  const mode = agent.mode?.replace(' permissions', '') ?? ''
  const modeChip = $('#reply-mode')
  setHtml(modeChip, `${icon('shield')}<span class="chip-text">${esc(mode || t('composer.modeDefault'))}</span>`)
  modeChip.classList.toggle('is-set', !!mode)
  modeChip.title = t('composer.modeHint', { mode: mode || t('composer.modeDefault') })
  setHtml($('#meta-cwd'), `${icon('folder')}${esc(shortCwd(agent.cwd, state.home))}`)
  setHtml($('#meta-branch'), agent.branch ? `${icon('branch')}${esc(agent.branch.name)}` : '')
  setHtml($('#meta-ctx'), agent.ctx != null ? esc(t('composer.context', { n: agent.ctx })) : '')
  // Claude Code's footer counts them too (`· 1 shell ·`), whatever the turn is doing.
  setHtml($('#meta-shells'), agent.shells ? `${icon('term')}${esc(t('composer.shells', { n: agent.shells }))}` : '')

  const goal = meta?.goal
  const bar = $('#goal-bar')
  bar.hidden = !goal || !['active', 'paused'].includes(goal.status)
  if (!bar.hidden) {
    const status = goal.status === 'paused' ? t('goal.paused') : working ? t('goal.running') : t('goal.waiting')
    setHtml(
      bar,
      `${icon('target')}<span class="goal-text">${esc(t('goal.label', { goal: goal.text }))}</span><span class="goal-status">${esc(status)}</span><button type="button" class="btn btn-sm btn-ghost" data-action="clear-goal">${esc(t('goal.clear'))}</button>`,
    )
  }
}

/**
 * The `reply` action. When the agent's input box in the terminal holds text nobody sent, the server sends
 * nothing (herdr would type the reply into the middle of it): the user decides whether to replace it.
 * Resolves to null when nothing was sent; failures other than a declined replacement are toasted.
 * @param {string} pane
 * @param {string} text
 * @param {string} [okMessage]
 */
async function replyAction(pane, text, okMessage) {
  try {
    const result = await sendReplacingDraft(
      discardDraft => sendAction({ op: 'reply', pane, text, ...(discardDraft === undefined ? {} : { discardDraft }) }),
      draftDialog,
    )
    if ('declined' in result) {
      toast(t('draft.kept'))
      return null
    }
    if (okMessage) toast(okMessage)
    return result.sent
  } catch (err) {
    if (!isUnauthorized(err)) toast(t('toast.actionFailed'), err.message, 'error')
    return null
  }
}

export function sendCommand(text, okMessage) {
  return replyAction(state.selected, text, okMessage).then(result => {
    if (result) setTimeout(() => loadThread(true), 1200)
    return result
  })
}

async function fetchCommandOutput(pane, command) {
  const mine = state.commandOutput
  for (const wait of COMMAND_OUTPUT_POLL_MS) {
    await sleep(wait)
    if (state.selected !== pane || state.commandOutput !== mine) return
    const inbox = agentBy(pane)?.inbox
    if (isUserOpened(inbox)) {
      state.commandOutput = null
      // A panel the chat has no card for (no options to tap): show it where it is.
      if (inbox?.source === 'panel') showPanelTerminal(pane, command)
      return renderLive()
    }
    const text = await getJson('/api/command-output', { pane, command })
      .then(body => body.text)
      .catch(() => null)
    if (state.commandOutput !== mine) return
    if (text) {
      state.commandOutput = { pane, command, text }
      return renderLive()
    }
  }
  if (state.commandOutput === mine) {
    state.commandOutput = null
    renderLive()
  }
}

function refreshConversation() {
  if (state.thread) renderConversation()
  else renderLive()
}

async function submit() {
  const agent = selectedAgent()
  if (!agent) return
  const el = textarea()
  // The second click of a double click (or a held Enter) lands here too: only what the button shows counts.
  const mode = sendMode(agent)
  if (mode === 'stop') return interrupt()
  if (mode !== 'send') return renderComposer()
  const text = embedAttachments(el.value, attachmentItems('reply'))
  if (!text) return
  sentAt = Date.now()
  closeSlash()
  const pane = state.selected
  const typed = el.value
  const attachments = state.attachments.reply
  rememberSentImages(
    typed,
    uploadParts(text).files.map(f => f.path),
  )
  el.value = ''
  saveDraft(pane, '')
  autosize(el)
  state.attachments.reply = []
  renderAttachments('reply')
  await sendReply(pane, text, { typed, attachments })
}

/** The message in the composer, queued for when the turn ends instead of sent into it. */
async function queueFromComposer() {
  const el = textarea()
  const pane = state.selected
  if (!pane || !selectedAgent() || uploadingCount('reply') > 0) return
  const text = embedAttachments(el.value, attachmentItems('reply'))
  if (!text) return
  closeSlash()
  const typed = el.value
  const attachments = state.attachments.reply
  rememberSentImages(
    typed,
    uploadParts(text).files.map(f => f.path),
  )
  el.value = ''
  saveDraft(pane, '')
  autosize(el)
  state.attachments.reply = []
  renderAttachments('reply')
  renderComposer()
  if (await queueReply(pane, text)) return
  if (state.selected !== pane || el.value.trim()) return
  el.value = typed
  saveDraft(pane, typed)
  state.attachments.reply = attachments
  renderAttachments('reply')
  autosize(el)
  renderComposer()
}

/** A queued message back in its pane's composer, after what is written there (its saved draft, if left). */
function editQueued(pane, text) {
  const { selected, draft } = composerOf(pane)
  const before = draft.replace(/\s+$/, '')
  const value = before ? `${before}\n\n${text}` : text
  saveDraft(pane, value)
  if (!selected) return
  const el = textarea()
  el.value = value
  autosize(el)
  renderComposer()
  el.focus()
}

/** What the composer of `pane` holds right now: the open textarea, or the saved draft of another pane. */
function composerOf(pane) {
  const selected = state.selected === pane
  return {
    selected,
    draft: selected ? textarea().value : draftFor(pane),
    composerAttachments: selected ? state.attachments.reply.length : 0,
  }
}

// Several sends can be in flight, to one pane or to several: each one only ever clears its own indicators,
// and a failure is settled against what that pane's composer holds by then, not against the open one.
function sendFailed(id, pane, text, { typed, attachments, restore }) {
  if (state.pendingMessage?.id === id) state.pendingMessage = null
  if (state.lastSent?.id === id) state.lastSent = null
  const recovery = recoverFailedSend({ ...composerOf(pane), typed, attachments, text, restore })
  if (recovery.to === 'card') addFailedSend(pane, text)
  else if (recovery.to === 'draft') saveDraft(pane, recovery.text)
  else {
    const el = textarea()
    el.value = recovery.typed
    saveDraft(pane, recovery.typed)
    state.attachments.reply = recovery.attachments
    renderAttachments('reply')
    autosize(el)
  }
  if (state.selected === pane) {
    renderComposer()
    refreshConversation()
  }
}

/**
 * Sends a reply to `pane`. `restore: false` (a retry from a "not sent" card) keeps a failure on the card.
 * @param {string} pane
 * @param {string} text
 * @param {{ typed?: string; attachments?: string[]; restore?: boolean }} [o]
 */
export async function sendReply(pane, text, { typed = text, attachments = [], restore = true } = {}) {
  const id = sendId()
  const thread = state.selected === pane ? state.thread : null
  state.pendingMessage = { id, pane, text, total: thread ? thread.more + thread.turns.length : 0, at: Date.now() }
  state.lastSent = { id, pane, text }
  if (state.selected === pane) {
    renderComposer()
    state.turnOpen.clear()
    state.commandOutput = null
    refreshConversation()
  }
  const result = await replyAction(pane, text)
  if (!result) {
    sendFailed(id, pane, text, { typed, attachments, restore })
    return null
  }
  if (SLASH_COMMAND_RE.test(text)) {
    if (state.pendingMessage?.id === id) state.pendingMessage = null
    const command = text.split(/\s/)[0]
    if (opensInTerminal(agentBy(pane)?.kind, command)) {
      showPanelTerminal(pane, command)
      return result
    }
    state.commandOutput = { pane, command, text: null }
    if (state.selected === pane) {
      refreshConversation()
      fetchCommandOutput(pane, command)
    }
  }
  if (state.selected === pane) loadThread(true)
  return result
}

/** The agent's next mode, as Shift+Tab in its terminal; the chip shows it once the footer does. */
function cycleMode() {
  if (state.selected) void postAction({ op: 'cycleMode', pane: state.selected })
}

/**
 * Stop the turn (`interrupt`, or `clearGoal`, which stops it first). When the server says the turn had
 * produced nothing yet, the message sent last goes back into an empty composer.
 */
async function stopAndRestore(op, okMessage) {
  const pane = state.selected
  const last = state.lastSent?.pane === pane ? state.lastSent.text : ''
  const result = await postAction({ op, pane, ...(last ? { last } : {}) }, okMessage)
  // The output of the command that started this turn (`/goal …` says "Goal set") is stale once it stops.
  if (result && state.commandOutput?.pane === pane) {
    state.commandOutput = null
    if (state.selected === pane) refreshConversation()
  }
  const el = textarea()
  if (result?.restored && state.selected === pane && !el.value.trim()) {
    el.value = last
    autosize(el)
    saveDraft(pane, last)
    renderComposer()
    el.focus()
  }
  return result
}

export function interrupt() {
  return stopAndRestore('interrupt', t('toast.stopped'))
}

async function clearGoal() {
  const agent = selectedAgent()
  if (!agent) return
  if (
    agent.status === 'working' &&
    !(await confirmDialog({
      title: t('goal.confirmTitle'),
      body: t('goal.confirmBody'),
      confirmLabel: t('goal.confirmClear'),
      danger: true,
    }))
  )
    return
  if (state.selected !== agent.pane) return
  const result = await stopAndRestore('clearGoal', t('toast.goalCleared'))
  if (result) setTimeout(() => loadThread(true), 1200)
}

async function openModelMenu(anchor) {
  const agent = selectedAgent()
  if (!agent) return
  const catalog = await modelCatalog(agent.kind)
  const current = runningModel(agent, catalog)
  const openFullMenu = {
    label: t('model.openMenu'),
    icon: 'more',
    run: () => sendCommand('/model', t('toast.pickBelow')),
  }
  if (agent.kind === 'codex') {
    // Codex's /model takes no argument: any pick opens its own picker, rendered as a menu card.
    const models = catalog.models.filter(m => m.id)
    return openMenu(anchor, [
      { header: t('model.codexHeader') },
      catalog.unavailable && { note: t('model.noCatalog') },
      ...models.map(m => ({ label: m.label, checked: m === current, run: openFullMenu.run })),
      models.length > 0 && { separator: true },
      openFullMenu,
    ])
  }
  openMenu(anchor, [
    { header: t('model.claudeHeader') },
    ...catalog.models.map(m => ({
      label: m.label,
      checked: m === current,
      hint: m.id ? m.id.replace(/^claude-/, '') : '',
      run: () => sendCommand(`/model ${m.id || 'default'}`, t('toast.modelSet', { model: m.label })),
    })),
    { separator: true },
    openFullMenu,
  ])
}

async function openEffortMenu(anchor) {
  const agent = selectedAgent()
  if (!agent) return
  if (agent.kind === 'codex') return sendCommand('/model', t('toast.pickBelow'))
  const catalog = await modelCatalog(agent.kind)
  const model = runningModel(agent, catalog)
  const efforts = model?.efforts.length ? model.efforts : catalogEfforts(catalog)
  const current = agent.effort || state.thread?.meta.effort
  openMenu(anchor, [
    { header: t('effort.header') },
    ...efforts.map(effort => ({
      label: effort,
      checked: effort === current,
      run: () => sendCommand(`/effort ${effort}`, t('toast.effortSet', { effort })),
    })),
    efforts.length > 0 && { separator: true },
    {
      label: agent.ultra ? t('effort.ultraOff') : t('effort.ultraOn'),
      icon: 'bolt',
      hint: t('effort.ultraHint'),
      run: () =>
        sendCommand(
          agent.ultra ? '/effort ultracode off' : '/effort ultracode',
          agent.ultra ? t('toast.ultraOff') : t('toast.ultraOn'),
        ),
    },
  ])
}

// On a phone the on-screen Return key makes a new line, like in any messenger; the send button sends.
export const isSendKey = e =>
  e.key === 'Enter' && !e.shiftKey && !e.isComposing && (!isTouch() || e.ctrlKey || e.metaKey)

export function initComposer() {
  const el = textarea()
  el.addEventListener('input', () => {
    autosize(el)
    if (state.selected) saveDraft(state.selected, el.value)
    renderComposer()
  })
  el.addEventListener('keydown', e => {
    // Ctrl/⌘+Enter queues behind a running turn; with none it sends, as it always has on a touch keyboard.
    const status = selectedAgent()?.status
    const busy = status === 'working' || status === 'blocked'
    if (busy && e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      queueFromComposer()
    } else if (isSendKey(e)) {
      e.preventDefault()
      $('#reply-form').requestSubmit()
    } else if (e.key === 'Tab' && e.shiftKey && !e.isComposing) {
      e.preventDefault()
      cycleMode()
    } else if (e.key === 'Escape') el.blur()
  })
  $('#reply-form').addEventListener('submit', e => {
    e.preventDefault()
    submit()
  })
  $('#goal-bar').addEventListener('click', e => {
    if (e.target.closest('[data-action="clear-goal"]')) clearGoal()
  })
  $('#reply-model').addEventListener('click', e => openModelMenu(e.currentTarget))
  $('#reply-effort').addEventListener('click', e => openEffortMenu(e.currentTarget))
  $('#reply-mode').addEventListener('click', () => cycleMode())
  $('#reply-queue-btn').addEventListener('click', () => queueFromComposer())
  initQueue({ sendNow: (pane, text) => void sendReply(pane, text), edit: editQueued })
  onAttachmentsChange(which => which === 'reply' && renderComposer())
}
