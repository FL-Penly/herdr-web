import { getJson, isUnauthorized } from './api.js'
import { attachmentThumb, sentImagesFor } from './attachments.js'
import { renderLive, resetLive } from './cards.js'
import { refreshTimes, timeHtml } from './clock.js'
import { renderComposer } from './composer.js'
import { diffLineClass } from './diff.js'
import { $, copyText, esc, icon, isNearBottom, patchKeyed } from './dom.js'
import { attachmentChips, duration, uploadDisplayName, uploadParts } from './format.js'
import { t } from './i18n/index.js'
import { noteText, runSummary, toolLabel } from './labels.js'
import { markdown, markdownText } from './markdown.js'
import { openMenu } from './menus.js'
import {
  INTERRUPTED_RE,
  groupSteps,
  hasBlockingDialog,
  historyControls,
  isLongUserText,
  lastReplyText,
  livePreview,
  pendingChange,
  readingAnchor,
  runCounts,
  showsDialogCard,
} from './model.js'
import { currentView } from './navigation.js'
import { toast } from './notify.js'
import { forkSession } from './pane-menu.js'
import { agentBy, isChatPane, selectedAgent, state } from './state.js'
import { renderStickyPrompt } from './sticky-prompt.js'
import { loadReplyImages } from './viewer.js'

const TURN_PAGE = 30
// While the agent works the thread is polled fast enough for the live preview to read as streaming.
const POLL_MS = { pending: 300, working: 700, idle: 3000 }
const MAX_POSITIONS = 60
const TOOL_ICON = {
  cmd: 'cmd',
  edit: 'file',
  read: 'eye',
  search: 'search',
  web: 'globe',
  task: 'users',
  todo: 'list',
  plan: 'file',
  skill: 'bolt',
  ask: 'q',
  other: 'cpu',
}

let pollTimer = null
let inflight = null

// Follow new output only while the reader is at the bottom, and never move the list under a finger.
const FOLLOW_SLACK_PX = 80
let following = true
let touching = false
// The pane whose thread is on screen, and where the reader was in each pane they left.
let shownPane = null
/** @type {Map<string, { anchor: { key: string; offset: number } | null; following: boolean; turnLimit: number; toolOpen: Map<string, boolean>; turnOpen: Map<string, boolean>; userExpanded: Set<string> }>} */
const positions = new Map()
let restoreTo = null

const scroller = () => $('#conversation')

/** Keeps the newest output in view after content changed, unless the reader scrolled up or is touching. */
export function followThread() {
  if (following && !touching) scroller().scrollTop = scroller().scrollHeight
  renderJump()
}

function renderJump() {
  const button = $('#jump-latest')
  button.hidden = following
  button.classList.toggle('is-needs', !following && !!$('#live').querySelector('.ask-card'))
}

export function stopThreadPolling() {
  clearTimeout(pollTimer)
  inflight?.controller.abort()
  inflight = null
}

/** Remembers where the reader is in the thread on screen, to come back to it after visiting another pane. */
export function saveReadingPosition() {
  const box = scroller()
  if (!shownPane || !state.thread || !box.clientHeight) return
  const top = box.getBoundingClientRect().top - box.scrollTop
  const blocks = [...$('#turns').children].map(el => {
    const rect = el.getBoundingClientRect()
    return { key: /** @type {HTMLElement} */ (el).dataset.key ?? '', top: rect.top - top, height: rect.height }
  })
  positions.delete(shownPane)
  positions.set(shownPane, {
    anchor: following ? null : readingAnchor(blocks, box.scrollTop),
    following,
    turnLimit: state.turnLimit,
    toolOpen: new Map(state.toolOpen),
    turnOpen: new Map(state.turnOpen),
    userExpanded: new Set(state.userExpanded),
  })
  if (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value)
}

/** Back from the terminal view: the hidden list lost its scroll position, so return to the saved one. */
export function restoreReadingPosition() {
  const saved = positions.get(state.selected ?? '')
  restoreTo = saved && !saved.following ? saved.anchor : null
}

export function resetThread() {
  saveReadingPosition()
  stopThreadPolling()
  const saved = positions.get(state.selected ?? '')
  shownPane = null
  state.thread = null
  state.threadVersion = ''
  state.turnLimit = saved?.turnLimit ?? TURN_PAGE
  state.prependPending = false
  state.lastStatus = undefined
  state.toolOpen = new Map(saved?.toolOpen)
  state.turnOpen = new Map(saved?.turnOpen)
  state.userExpanded = new Set(saved?.userExpanded)
  restoreTo = saved && !saved.following ? saved.anchor : null
  $('#turns').replaceChildren()
  renderStickyPrompt()
  resetLive()
  following = true
  renderJump()
}

function pollDelay(pane) {
  if (state.pendingMessage?.pane === pane) return POLL_MS.pending
  const agent = agentBy(pane)
  // A permission card waits for the transcript to record the change it asks about.
  const inbox = agent?.inbox
  if (inbox?.reason === 'permission' && !pendingChange(state.thread, inbox.question)) return POLL_MS.working
  return agent?.status === 'working' ? POLL_MS.working : POLL_MS.idle
}

function schedule(pane) {
  clearTimeout(pollTimer)
  if (pane === state.selected) pollTimer = setTimeout(() => loadThread(false), pollDelay(pane))
}

// A forced load (pane switch, send, "load more") supersedes a poll still in flight instead of being dropped.
export async function loadThread(force = false) {
  clearTimeout(pollTimer)
  const pane = state.selected
  if (!isChatPane(pane) || currentView() !== 'chat') return
  if (inflight) {
    if (!force && inflight.pane === pane) return
    inflight.controller.abort()
  }
  const request = { pane, controller: new AbortController() }
  inflight = request
  let thread
  try {
    thread = await getJson('/api/thread', { pane, turns: state.turnLimit }, request.controller.signal)
  } catch (err) {
    if (request.controller.signal.aborted) return
    inflight = null
    if (isUnauthorized(err)) return
    if (force) toast(t('toast.threadFailed'), err.message, 'error')
    schedule(pane)
    return
  }
  if (inflight !== request) return
  inflight = null
  if (pane !== state.selected) return
  const pending = state.pendingMessage
  const total = thread.more + thread.turns.length
  const expired = pending && Date.now() - pending.at > (pending.starting ? 90_000 : 12_000)
  const cleared = pending?.pane === pane && (total > pending.total || expired)
  if (cleared) state.pendingMessage = null
  const liveChanged = (thread.meta.live?.text ?? '') !== (state.thread?.meta.live?.text ?? '')
  if (force || cleared || liveChanged || thread.meta.version !== state.threadVersion) {
    shownPane = pane
    state.thread = thread
    state.threadVersion = thread.meta.version
    renderConversation()
    renderComposer()
  }
  schedule(pane)
}

function userHtml(turn) {
  const user = turn.user
  if (INTERRUPTED_RE.test(user.text.trim())) {
    return `<div class="system-note">${icon('x', 'xs')}${esc(t('thread.interrupted'))}</div>`
  }
  if (!user.answers?.length) return userBubbleHtml(user.text, turn.id, { images: user.images })
  const images = user.images
    ? `<div class="msg-user-images">${icon('image')}${esc(t('thread.images', { n: user.images }))}</div>`
    : ''
  const body = `<div class="msg-bubble msg-answers">${user.answers
    .map(
      a =>
        `<div class="msg-answer"><span class="msg-answer-q">${esc(a.question)}</span><span>${esc(a.answer)}</span></div>`,
    )
    .join('')}</div>`
  return `<div class="msg-user"><div class="msg-user-inner">${images}${body}</div></div>`
}

// Files uploaded through herdr-web reach the agent as long server paths; show them as named attachments.
function filesHtml(files) {
  if (!files.length) return ''
  const chips = files
    .map(f => {
      const thumb = f.image ? attachmentThumb(f.path) : ''
      const glyph = thumb ? `<img src="${esc(thumb)}" alt="">` : icon(f.image ? 'image' : 'file')
      return `<button type="button" class="msg-file${thumb ? ' has-thumb' : ''}" title="${esc(f.path)}" data-open-file="${esc(f.path)}">${glyph}<span class="msg-file-name">${esc(f.name)}</span></button>`
    })
    .join('')
  return `<div class="msg-files">${chips}</div>`
}

/**
 * @param {string} raw
 * @param {string | null} turnId null for a message not in the transcript yet
 * @param {{ pending?: boolean; images?: number }} [o]
 */
function userBubbleHtml(raw, turnId, { pending = false, images: total = 0 } = {}) {
  // Attachments put in place with a token (`[图片1]`) show there, as capsules; only the others are listed above.
  const sentImages = sentImagesFor(raw)
  const marked = attachmentChips(raw, sentImages)
  const images = Math.max(0, total - marked.images)
  // Claude Code turns a pasted image path into an `[Image #n]` marker; the image note above says it already.
  const parts = uploadParts(images ? marked.text.replace(/\[Image #\d+\]\s*/g, '') : marked.text)
  const { text } = parts
  let { files } = parts
  // Images sent from this tab come back as markers only; show them by name and picture again.
  const sent = images && !files.length ? sentImages.slice(marked.images) : []
  if (images && sent.length === images) files = sent.map(path => ({ path, name: uploadDisplayName(path), image: true }))
  const imageNote =
    images && !files.length
      ? `<div class="msg-user-images">${icon('image')}${esc(t('thread.images', { n: images }))}</div>`
      : ''
  const clamped = !!turnId && isLongUserText(text) && !state.userExpanded.has(turnId)
  const expand = clamped
    ? `<button type="button" class="msg-expand" data-action="expand-user" data-turn="${esc(turnId)}">${esc(t('thread.expand'))}</button>`
    : ''
  const body = esc(text).replace(/\u0001(\d+)\u0001/g, (_, i) => chipHtml(marked.chips[Number(i)]))
  const bubble = text ? `<div class="msg-bubble${clamped ? ' is-clamped' : ''}">${body}${expand}</div>` : ''
  return `<div class="msg-user${pending ? ' is-pending' : ''}"><div class="msg-user-inner">${imageNote}${filesHtml(files)}${bubble}</div></div>`
}

/** @param {{ label: string; path: string | null; image: boolean } | undefined} chip */
function chipHtml(chip) {
  if (!chip) return ''
  const thumb = chip.image && chip.path ? attachmentThumb(chip.path) : ''
  const glyph = thumb ? `<img src="${esc(thumb)}" alt="">` : icon(chip.image ? 'image' : 'file', 'xs')
  const inner = `${glyph}${esc(chip.label)}`
  return chip.path
    ? `<button type="button" class="msg-chip" data-open-file="${esc(chip.path)}" title="${esc(chip.path)}">${inner}</button>`
    : `<span class="msg-chip">${inner}</span>`
}

function noteHtml(note) {
  const { text, tone } = noteText(note)
  const glyph = tone === 'ok' ? 'check' : tone === 'output' ? 'cmd' : 'target'
  return `<div class="note note-${tone}">${icon(glyph)}<pre>${esc(text)}</pre></div>`
}

function toolStatusHtml(step) {
  if (step.tool === 'edit') {
    return `<span class="tool-meta"><span class="diff-add">+${step.added ?? 0}</span> <span class="diff-del">−${step.removed ?? 0}</span></span>`
  }
  if (step.status === 'error') return `<span class="tool-meta is-error">${esc(t('tool.failed'))}</span>`
  if (step.status === 'running') return `<span class="tool-meta">${esc(t('tool.running'))}</span>`
  if (step.tool === 'cmd') return `<span class="tool-meta is-ok">${icon('check')}</span>`
  return ''
}

function diffTextHtml(text) {
  return String(text ?? '')
    .split('\n')
    .map(line => {
      const cls = diffLineClass(line)
      return cls ? `<span class="diff-line-${cls}">${esc(line)}</span>` : `${esc(line)}\n`
    })
    .join('')
}

function toolBodyHtml(step) {
  if (step.status === 'error' && step.output) return `<div class="tool-output">${esc(step.output)}</div>`
  if (step.tool === 'edit') return `<div class="tool-output">${diffTextHtml(step.diff ?? step.output)}</div>`
  if (step.tool === 'plan') return `<div class="tool-output markdown">${markdown(step.output)}</div>`
  return `<div class="tool-output">${esc(step.output)}</div>`
}

function toolHtml(step, key) {
  const openable = !!(step.output || step.diff)
  const open = state.toolOpen.get(key) ?? step.status === 'error'
  const inner = `${icon(TOOL_ICON[step.tool] ?? 'cpu')}<b class="tool-label">${esc(toolLabel(step))}</b><span class="tool-detail">${esc(step.detail)}</span>${toolStatusHtml(step)}`
  const head = openable
    ? `<button type="button" class="tool-step is-openable" data-action="toggle-tool" data-key="${esc(key)}" aria-expanded="${open}">${inner}</button>`
    : `<div class="tool-step">${inner}</div>`
  return openable && open ? head + toolBodyHtml(step) : head
}

/**
 * A run of tool calls folded into one line (`Ran 3 shell commands, read 2 files`), as Claude Code and Codex
 * print it; open, each call. A run still going shows its calls, like the TUI shows the running one.
 * @param {Extract<import('./model.js').StepBlock, { type: 'run' }>} run
 * @param {string} turnId
 */
function runHtml(run, turnId) {
  const key = `${turnId}:run:${run.index}`
  const open = state.toolOpen.get(key) ?? run.running
  const failed = run.failed ? `<span class="run-failed">${esc(t('run.failed', { n: run.failed }))}</span>` : ''
  const head = `<button type="button" class="run-step" data-action="toggle-tool" data-key="${esc(key)}" aria-expanded="${open}">${icon('right')}<span class="run-summary">${esc(runSummary(runCounts(run.steps)))}</span>${failed}</button>`
  if (!open) return head
  const calls = run.steps.map(({ step, index }) => toolHtml(step, `${turnId}:${step.id || index}`)).join('')
  return `${head}<div class="run-calls">${calls}</div>`
}

function stepHtml(step, turnId, index) {
  switch (step.type) {
    case 'text':
      return `<div class="msg-assistant markdown">${markdown(step.text)}</div>`
    case 'note':
      return noteHtml(step)
    case 'tool':
      return toolHtml(step, `${turnId}:${step.id || index}`)
    default:
      return ''
  }
}

function replyActionsHtml(turn) {
  const fork = turn.forkAt
    ? `<button type="button" class="icon-btn icon-btn-sm" data-action="fork-at" data-fork-at="${esc(turn.forkAt)}" aria-label="${esc(t('thread.forkHere'))}" title="${esc(t('thread.forkHere'))}" aria-haspopup="menu">${icon('fork')}</button>`
    : ''
  return `<div class="reply-actions"><button type="button" class="icon-btn icon-btn-sm" data-action="copy" data-turn="${esc(turn.id)}" aria-label="${esc(t('thread.copy'))}" title="${esc(t('thread.copy'))}" aria-haspopup="menu">${icon('copy')}</button>${fork}${timeHtml(turn.end, 'reply-time')}</div>`
}

// A proposed plan is the answer of its turn, not a step of the work: always shown, never folded away.
const isPlan = step => step.type === 'tool' && step.tool === 'plan' && !!step.output

function planHtml(step) {
  const waiting = step.status === 'running' ? `<span class="plan-tag">${esc(t('thread.planWaiting'))}</span>` : ''
  return `<section class="plan-block"><div class="plan-head">${icon('list')}<span>${esc(t('thread.plan'))}</span>${waiting}</div><div class="markdown">${markdown(step.output)}</div></section>`
}

/**
 * @param {import('../../src/protocol.ts').Turn} turn
 * @param {boolean} live the agent is working on this turn
 * @param {boolean} beforeCard a dialog card follows this turn: its plan goes last, right above the card
 */
function turnHtml(turn, live, beforeCard) {
  const parts = []
  if (turn.user) parts.push(userHtml(turn))
  const steps = turn.steps
  if (steps.length) {
    const hasWork = steps.some(s => s.type === 'tool' && !isPlan(s))
    const open = state.turnOpen.get(turn.id) ?? live
    const finalIndex = steps.map(s => s.type).lastIndexOf('text')
    if (hasWork) {
      parts.push(
        `<button type="button" class="turn-toggle" data-action="toggle-turn" data-turn="${esc(turn.id)}" aria-expanded="${open}">${icon('right')}<span>${esc(t('thread.worked', { duration: duration(turn.end - turn.start) }))}</span><span class="turn-rule"></span></button>`,
      )
    }
    const plans = []
    for (const block of groupSteps(steps)) {
      if (block.type === 'run') {
        if (open) parts.push(runHtml(block, turn.id))
        continue
      }
      const { step, index: i } = block
      if (isPlan(step)) {
        if (beforeCard) plans.push(planHtml(step))
        else parts.push(planHtml(step))
        continue
      }
      const keep = open || !hasWork || i === finalIndex || (step.type === 'note' && step.code === 'goal.complete')
      if (keep) parts.push(stepHtml(step, turn.id, i))
    }
    if (finalIndex >= 0 && !live) parts.push(replyActionsHtml(turn))
    parts.push(...plans)
  }
  return `<article class="turn">${parts.join('')}</article>`
}

function liveReplyHtml(text) {
  return `<article class="live-reply" aria-live="off"><div class="live-reply-tag"><span class="dot dot-running" aria-hidden="true"></span>${esc(t('thread.liveTag'))}</div><div class="msg-assistant markdown">${markdown(text)}</div></article>`
}

export function renderConversation() {
  const thread = state.thread
  if (!thread) return
  const box = scroller()
  const list = $('#turns')
  if (!list.children.length) following = true
  const prevHeight = box.scrollHeight
  const prevTop = box.scrollTop
  const agent = selectedAgent()
  const working = agent?.status === 'working'
  const pending = state.pendingMessage?.pane === state.selected ? state.pendingMessage : null
  const asks = agent?.kind === 'codex' && !hasBlockingDialog(agent) ? thread.meta.pending.length : 0
  const cardFollows = showsDialogCard(agent, asks)
  const blocks = []
  const history = historyControls(thread, state.turnLimit, TURN_PAGE)
  if (history.loadMore) {
    const label = t('thread.loadMore', { n: history.loadMore, total: history.available })
    blocks.push({
      key: 'more',
      html: `<button type="button" class="load-more" data-action="more-turns">${esc(label)}</button>`,
    })
  } else if (history.unavailable) {
    blocks.push({ key: 'truncated', html: `<div class="history-note">${esc(t('thread.truncated'))}</div>` })
  }
  if (!thread.turns.length && !pending) {
    blocks.push({
      key: 'empty',
      html: `<div class="empty-thread"><b>${esc(t('thread.emptyTitle'))}</b>${esc(t('thread.emptyBody'))}</div>`,
    })
  }
  const lastIndex = thread.turns.length - 1
  thread.turns.forEach((turn, i) => {
    const last = i === lastIndex
    blocks.push({ key: `turn:${turn.id}`, html: turnHtml(turn, working && last, cardFollows && last) })
  })
  if (pending) blocks.push({ key: 'pending', html: userBubbleHtml(pending.text, null, { pending: true }) })
  const live = working ? livePreview(thread) : ''
  if (live) blocks.push({ key: 'live-reply', html: liveReplyHtml(live) })
  patchKeyed(list, blocks)
  refreshTimes(list)
  loadReplyImages(list, state.selected)
  renderLive()
  if (restoreTo) restorePosition(box, list)
  else if (state.prependPending) box.scrollTop = prevTop + (box.scrollHeight - prevHeight)
  else if (following) followThread()
  else if (!touching && box.scrollTop !== prevTop) box.scrollTop = prevTop
  state.prependPending = false
  renderJump()
  renderStickyPrompt()
}

// Back in a pane the reader left: the block they were reading goes where it was. A block that is gone (or
// not loaded yet) leaves the thread at its newest message.
function restorePosition(box, list) {
  const { key, offset } = restoreTo
  restoreTo = null
  const el = list.querySelector(`[data-key="${CSS.escape(key)}"]`)
  if (!el) return followThread()
  following = false
  box.scrollTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop + offset
}

function copyMenu(button) {
  const turn = state.thread?.turns.find(x => x.id === button.dataset.turn)
  if (!turn) return
  const text = lastReplyText(turn)
  openMenu(button, [
    { label: t('thread.copyMarkdown'), icon: 'copy', run: () => copyReply(button, text) },
    { label: t('thread.copyPlain'), icon: 'copy', run: () => copyReply(button, markdownText(text)) },
  ])
}

async function copyReply(button, text) {
  if (!(await copyText(text))) return toast(t('toast.copyFailed'), '', 'error')
  button.innerHTML = icon('check')
  setTimeout(() => {
    button.innerHTML = icon('copy')
  }, 1200)
}

function forkMenu(button) {
  const at = button.dataset.forkAt
  openMenu(button, [
    { header: t('fork.fromReply') },
    { label: t('fork.toTab'), icon: 'fork', run: () => forkSession('tab', at) },
    { label: t('fork.toRight'), icon: 'side', run: () => forkSession('right', at) },
    { label: t('fork.toDown'), icon: 'side', run: () => forkSession('down', at) },
  ])
}

function initFollow() {
  const box = scroller()
  let height = box.clientHeight
  box.addEventListener(
    'scroll',
    () => {
      // A shrinking list (the keyboard opening, a phone turned sideways) fires a scroll before the resize
      // observer runs; that is not the reader scrolling up.
      if (box.clientHeight !== height) {
        height = box.clientHeight
        if (following) followThread()
        return
      }
      following = isNearBottom(box, FOLLOW_SLACK_PX)
      renderJump()
    },
    { passive: true },
  )
  const release = () => (touching = false)
  // The live rows re-render every second; a touch on one that was replaced ends on the detached node and
  // never bubbles here, so listen on the node it started on too.
  box.addEventListener(
    'touchstart',
    e => {
      touching = true
      for (const type of ['touchend', 'touchcancel']) e.target?.addEventListener(type, release, { once: true })
    },
    { passive: true },
  )
  box.addEventListener('touchend', release, { passive: true })
  box.addEventListener('touchcancel', release, { passive: true })
  // The keyboard opening shrinks the list; stay on the newest message if that is where the reader was.
  new ResizeObserver(() => {
    height = box.clientHeight
    if (following) followThread()
  }).observe(box)
  $('#jump-latest').addEventListener('click', () => {
    following = true
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
    renderJump()
  })
}

export function initThread() {
  initFollow()
  $('#turns').addEventListener('click', e => {
    const target = e.target.closest('[data-action]')
    if (!target) return
    switch (target.dataset.action) {
      case 'toggle-tool': {
        const key = target.dataset.key
        state.toolOpen.set(key, target.getAttribute('aria-expanded') !== 'true')
        return renderConversation()
      }
      case 'toggle-turn':
        state.turnOpen.set(target.dataset.turn, target.getAttribute('aria-expanded') !== 'true')
        return renderConversation()
      case 'expand-user':
        state.userExpanded.add(target.dataset.turn)
        return renderConversation()
      case 'copy':
        return copyMenu(target)
      case 'fork-at':
        return forkMenu(target)
      case 'more-turns': {
        const next = state.thread && historyControls(state.thread, state.turnLimit, TURN_PAGE).nextLimit
        if (!next || next === state.turnLimit) return
        state.turnLimit = next
        state.prependPending = true
        return loadThread(true)
      }
    }
  })
}
