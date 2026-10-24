import { isUnauthorized, postAction, sendAction } from './api.js'
import { elapsedHtml, refreshTimes } from './clock.js'
import { sendReply } from './composer.js'
import { diffLineClass, diffRows } from './diff.js'
import { $, esc, icon, isNarrow, patchKeyed } from './dom.js'
import { activityLabel, shortCwd } from './format.js'
import { t } from './i18n/index.js'
import { DOUBLE_CLICK_MS, inflight } from './inflight.js'
import {
  cardKey,
  changeLines,
  hasBlockingDialog,
  isAffirmative,
  isCutPreview,
  isFreeTextOption,
  isUserOpened,
  kindLabel,
  needsReveal,
  optionAction,
  optionShortcut,
  pendingChange,
  revealedText,
  shellsAfterTurn,
  showsDialogCard,
  splitQuestion,
} from './model.js'
import { setView } from './navigation.js'
import { toast } from './notify.js'
import { failedSendsFor, removeFailedSend } from './sends.js'
import { agentBy, firstMessageFor, selectedAgent, state } from './state.js'
import { followThread, loadThread } from './thread.js'

let lastHtml = ''
// Permission cards whose proposed change the reader expanded to its full height, by card key.
const expandedChanges = new Set()
// Typed into a question card but not sent yet, by card and field; outlives a card that has to be redrawn.
const answerDrafts = new Map()
// The whole dialog read off Claude Code's terminal, by pane: `{episode, key, value}` with the text, 'reading' or
// 'failed'. Only for that one episode: a later prompt can end on the same rows and propose something else.
const revealed = new Map()
// A single change usually reaches the transcript within this long; paging the terminal is for when it does not.
const REVEAL_AFTER_MS = 1200

export function resetLive() {
  lastHtml = ''
  answerDrafts.clear()
  $('#live').replaceChildren()
}

const progressHtml = (label, extra = '') =>
  `<div class="live-status"><span class="dot dot-running" aria-hidden="true"></span><span class="shimmer">${esc(label)}</span>${extra}</div>`

function commandOutputCard() {
  const output = state.commandOutput
  if (output?.pane !== state.selected) return ''
  if (output.text == null) return progressHtml(t('live.runningCommand', { command: output.command }))
  return `<div class="note note-output command-output">${icon('cmd')}<div class="command-output-body"><div class="command-output-head">${esc(output.command)} · ${esc(t('live.terminalOutput'))}<button type="button" class="icon-btn icon-btn-sm" data-action="close-output" aria-label="${esc(t('live.close'))}">${icon('x', 'xs')}</button></div><pre>${esc(output.text)}</pre></div></div>`
}

function asyncAskCard(pending) {
  if (!pending.length) return ''
  const ask = pending[0]
  const more = pending.length > 1 ? t('ask.more', { n: pending.length - 1 }) : ''
  const options = ask.options
    .map(
      (option, i) =>
        `<button type="button" class="option" data-action="async-option" data-option="${esc(option)}" data-question="${esc(ask.title)}"><span class="option-key">${i + 1}</span><span>${esc(option)}</span></button>`,
    )
    .join('')
  return `<section class="ask-card" data-question="${esc(ask.title)}" aria-label="${esc(t('ask.codexAsking'))}"><div class="ask-head">${icon('q', 'md')}${esc(t('ask.codexAsking'))}${esc(more)}<span class="ask-tag">${esc(t('ask.nonBlocking'))}</span></div>
    <pre>${esc(ask.title)}</pre>${options}
    <form class="other-form" data-field="other"><input class="input" placeholder="${esc(t('ask.otherAnswer'))}" autocomplete="off" aria-label="${esc(t('ask.otherAnswer'))}"><button type="submit" class="btn btn-sm">${esc(t('ask.answer'))}</button></form></section>`
}

function progressCard(agent) {
  const pending = state.pendingMessage
  const first = firstMessageFor(state.selected)
  const idle = agent?.status !== 'working' && agent?.status !== 'blocked'
  if (first?.status === 'queued' && idle) {
    return progressHtml(t('live.starting', { agent: kindLabel(pending?.starting ?? agent?.kind ?? '') }))
  }
  if (pending?.pane === state.selected && idle) {
    return progressHtml(
      pending.starting ? t('live.starting', { agent: kindLabel(pending.starting) }) : t('live.sending'),
    )
  }
  if (agent?.status === 'working') {
    return progressHtml(activityLabel(agent.activity) || t('live.working'), elapsedHtml(agent.since, 'live-elapsed'))
  }
  // Claude Code's own line under a finished turn: `✻ … · done 2:37 PM · 1 shell still running`, no spinner.
  const shells = shellsAfterTurn(agent)
  if (shells)
    return `<div class="live-status turn-end">${icon('term')}<span>${esc(t('live.shellsRunning', { n: shells }))}</span></div>`
  return ''
}

function dialogTitle(inbox) {
  if (inbox.reason === 'trust') return t('dialog.trustTitle')
  if (inbox.form?.review) return t('dialog.reviewTitle')
  if (inbox.reason === 'permission') return t('dialog.permissionTitle')
  if (inbox.options.length) return t('dialog.choiceTitle')
  return inbox.source === 'panel' ? t('dialog.panelTitle') : t('dialog.blockedTitle')
}

function dialogQuestion(inbox) {
  if (inbox.reason === 'trust') {
    return [t('dialog.trustBody'), shortCwd(inbox.folder ?? '', state.home)].filter(Boolean).join('\n')
  }
  return inbox.question || (inbox.options.length ? '' : t('dialog.blockedBody'))
}

const optionData = option => `data-key="${esc(option.key)}" data-label="${esc(option.label)}"`

function permissionButtons(inbox) {
  const buttons = inbox.options.map(option => {
    const primary = isAffirmative(option.label) && option.key === '1'
    // The description carries the scope of an option ("Yes, allow reading from" … which folder).
    const desc = option.desc ? `<small class="btn-desc">${esc(option.desc)}</small>` : ''
    return `<button type="button" class="btn btn-sm${primary ? ' btn-primary' : ''}${desc ? ' has-desc' : ''}" data-action="option" ${optionData(option)}>${primary ? icon('check') : ''}<span class="btn-text">${esc(option.label)}${desc}</span></button>`
  })
  const keys = inbox.options.map((o, i) => `<kbd>${esc(optionShortcut(o, i))}</kbd>`).join(' ')
  return `<div class="ask-buttons">${buttons.join('')}<span class="ask-keys">${keys} · <kbd>Esc</kbd></span></div>`
}

function choiceOptions(inbox) {
  return inbox.options
    .map((option, i) => {
      const key = esc(optionShortcut(option, i))
      if (isFreeTextOption(option.label)) {
        const placeholder = `${option.label.replace(/\.$/, '')}…`
        return `<form class="other-form" data-field="${esc(option.label)}" ${optionData(option)}><span class="option-key">${key}</span><input class="input" placeholder="${esc(placeholder)}" aria-label="${esc(option.label)}" autocomplete="off"><button type="submit" class="btn btn-sm">${esc(t('ask.send'))}</button></form>`
      }
      const desc = option.desc ? `<small>${esc(option.desc)}</small>` : ''
      const current = option.current ? ' aria-current="true"' : ''
      return `<button type="button" class="option" data-action="option" ${optionData(option)}${current}><span class="option-key">${key}</span><span>${esc(option.label)}${desc}</span></button>`
    })
    .join('')
}

// The change a permission is about, in full: the card is where it is decided, so it must not take the TUI's
// cut-down preview for it.
function changeRowsHtml(step, lines) {
  if (lines.some(l => l.startsWith('@@'))) {
    return diffRows(lines)
      .map(row =>
        row.type === 'hunk' || row.type === 'note'
          ? `<div class="change-hunk">${esc(row.text)}</div>`
          : `<div class="change-row is-${row.type}"><span class="change-gutter">${row.line ?? ''}</span><span>${esc(row.text)}</span></div>`,
      )
      .join('')
  }
  const additionsOnly = lines.every(l => l.startsWith('+'))
  return lines
    .map((line, i) => {
      const cls = diffLineClass(line) || 'ctx'
      const text = additionsOnly ? line.slice(1) : line
      return `<div class="change-row is-${cls}"><span class="change-gutter">${additionsOnly ? i + 1 : ''}</span><span>${esc(text)}</span></div>`
    })
    .join('')
}

function changeHtml(step, key) {
  if (step.tool === 'cmd') {
    return `<div class="change-block"><div class="change-head">${icon('cmd')}<b>${esc(t('change.command'))}</b></div><pre class="change-cmd">${esc(step.detail)}</pre></div>`
  }
  const { lines, clipped } = changeLines(step)
  if (!lines.length) return ''
  const name = step.detail || step.path || ''
  const counts = `<span class="diff-add">+${step.added ?? 0}</span><span class="diff-del">−${step.removed ?? 0}</span>`
  const scope = clipped ? t('change.showingFirst', { n: lines.length }) : t('change.showingAll', { n: lines.length })
  const long = lines.length > 14
  const expanded = expandedChanges.has(key)
  const toggle = long
    ? `<button type="button" class="btn btn-sm btn-ghost change-toggle" data-action="toggle-change" aria-expanded="${expanded}">${esc(expanded ? t('change.collapse') : t('change.expand', { n: lines.length }))}</button>`
    : ''
  return `<div class="change-block"><div class="change-head">${icon('file')}<b class="change-name" title="${esc(step.path ?? name)}">${esc(name)}</b>${counts}<span class="change-scope">${esc(scope)}</span></div><div class="change-body${long && !expanded ? ' is-clamped' : ''}" tabindex="0">${changeRowsHtml(step, lines)}</div>${toggle}</div>`
}

// Several questions in one dialog: which are answered, and on the submit tab what was chosen, which Claude does
// not have until it is submitted.
function formHtml(inbox) {
  const { steps, review } = inbox.form
  // Claude moves on to the next unanswered question by itself; one gone back to shows its answer with a ✔.
  const revisited = inbox.options.some(o => o.label.endsWith('✔'))
  const current = review || revisited ? -1 : steps.findIndex(s => !s.done)
  const items = steps.map((s, i) => {
    const cls = s.done ? 'is-done' : i === current ? 'is-current' : ''
    return `<li${cls ? ` class="${cls}"` : ''}>${s.done ? icon('check', 'xs') : ''}${esc(s.label)}</li>`
  })
  items.push(`<li${review ? ' class="is-current"' : ''}>${esc(t('dialog.submitStep'))}</li>`)
  const progress = `<ol class="ask-steps" aria-label="${esc(t('dialog.steps'))}">${items.join('')}</ol>`
  if (!review) return `${progress}<p class="ask-question">${esc(inbox.question)}</p>`
  const answers = review.map(r => `<dt>${esc(r.question)}</dt><dd>${esc(r.answer)}</dd>`).join('')
  const ask = inbox.question.split('\n').slice(review.length).join('\n')
  return `${progress}<p class="ask-note">${esc(t('dialog.reviewNote'))}</p><dl class="ask-review">${answers}</dl>${ask ? `<p class="ask-question">${esc(ask)}</p>` : ''}`
}

function questionHtml(inbox, key) {
  if (inbox.form) return formHtml(inbox)
  const question = dialogQuestion(inbox)
  const change =
    inbox.reason === 'permission' || inbox.reason === 'choice' ? pendingChange(state.thread, inbox.question) : null
  const block = change ? changeHtml(change, key) : ''
  // Claude Code asks before it records the message that holds the change, so for a while only the screen has
  // it, and a change taller than the pane shows only its end. Never let that pass for the whole change.
  if (!block && inbox.reason === 'permission' && isCutPreview(question)) {
    const whole = revealedText(revealed.get(state.selected), inbox, key)
    if (whole && whole !== 'reading' && whole !== 'failed') {
      const { preview, ask } = splitQuestion(whole)
      return `<div class="change-note" role="note">${icon('cmd')}<span>${esc(t('change.fromTerminal'))}</span></div><pre class="is-whole">${esc(preview)}</pre>${ask ? `<p class="ask-question">${esc(ask)}</p>` : ''}`
    }
    const { preview, ask } = splitQuestion(question)
    const note = whole === 'reading' ? t('change.revealing') : t('change.partialPreview')
    return `<div class="change-partial" role="note">${icon('eye')}<span>${esc(note)}</span><button type="button" class="btn btn-sm" data-action="go-terminal">${esc(t('change.openTerminal'))}</button></div><pre class="is-partial">${esc(preview)}</pre>${ask ? `<p class="ask-question">${esc(ask)}</p>` : ''}`
  }
  if (!block) return question ? `<pre>${esc(question)}</pre>` : ''
  // The TUI's own preview shows only the end of the change; it stays available, folded, under the full one.
  const { preview, ask } = splitQuestion(question)
  const folded = preview
    ? `<details class="question-preview"><summary>${esc(t('change.terminalPreview'))}</summary><pre>${esc(preview)}</pre></details>`
    : ''
  return `${block}${folded}${ask ? `<p class="ask-question">${esc(ask)}</p>` : ''}`
}

function dialogCard(agent, pendingCount) {
  if (!showsDialogCard(agent, pendingCount)) return ''
  const inbox = agent.inbox
  const permission = inbox.reason === 'permission'
  const userOpened = isUserOpened(inbox)
  const waited = userOpened ? '' : `<span class="ask-tag">${esc(t('dialog.waited'))} ${elapsedHtml(agent.since)}</span>`
  const key = cardKey(inbox)
  const body = permission
    ? permissionButtons(inbox)
    : `${choiceOptions(inbox)}<div class="ask-buttons"><button type="button" class="btn btn-sm btn-ghost" data-action="option" data-key="esc">${esc(inbox.source === 'panel' ? t('dialog.close') : t('dialog.cancel'))} (Esc)</button><button type="button" class="btn btn-sm btn-ghost" data-action="go-terminal">${esc(t('dialog.handleInTerminal'))}</button></div>`
  const glyph = permission || inbox.reason === 'trust' ? 'shield' : 'q'
  return `<section class="ask-card" data-card="${esc(key)}" data-question="${esc(inbox.question)}" aria-label="${esc(dialogTitle(inbox))}"><div class="ask-head">${icon(glyph, 'md')}${esc(dialogTitle(inbox))}${waited}</div>${questionHtml(inbox, key)}${body}</section>`
}

function failedCard({ kind, id, text, title, reason }) {
  const why = reason ? `<p class="failed-reason">${esc(reason)}</p>` : ''
  return `<section class="ask-card failed-card" data-kind="${kind}" data-id="${esc(id)}" aria-label="${esc(title)}"><div class="ask-head">${icon('x', 'md')}${esc(title)}</div>${why}<pre>${esc(text)}</pre><div class="ask-buttons"><button type="button" class="btn btn-sm btn-primary" data-action="resend">${esc(t('failed.sendAgain'))}</button><button type="button" class="btn btn-sm" data-action="edit-failed">${esc(t('failed.edit'))}</button><button type="button" class="btn btn-sm btn-ghost" data-action="dismiss-failed">${esc(t('failed.dismiss'))}</button></div></section>`
}

function failedBlocks() {
  const blocks = failedSendsFor(state.selected).map(f => ({
    key: `failed:${f.id}`,
    html: failedCard({ kind: 'send', id: f.id, text: f.text, title: t('failed.sendTitle') }),
  }))
  const first = firstMessageFor(state.selected)
  if (first?.status === 'failed') {
    const reason = first.error === 'expired' ? t('failed.expired') : t('failed.sendFailed')
    blocks.unshift({
      key: 'failed:first',
      html: failedCard({ kind: 'first', id: first.pane, text: first.text, title: t('failed.firstTitle'), reason }),
    })
  }
  return blocks
}

const fieldKey = (card, form) => `${card?.dataset.key ?? ''}#${form.dataset.field ?? ''}`

// Remember what is typed, where the caret is and whether it has focus, so a card that is redrawn gets it back
// without the phone keyboard closing or the caret jumping to the end.
function captureFields(box) {
  const fields = new Map()
  for (const form of box.querySelectorAll('form.other-form')) {
    const input = form.querySelector('input')
    if (!input) continue
    const focused = document.activeElement === input
    if (!input.value && !focused) continue
    const key = fieldKey(form.closest('[data-key]'), form)
    fields.set(key, { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused })
  }
  return fields
}

function restoreFields(box, fields) {
  for (const form of box.querySelectorAll('form.other-form')) {
    const input = form.querySelector('input')
    const key = fieldKey(form.closest('[data-key]'), form)
    const saved = fields.get(key) ?? (answerDrafts.has(key) ? { value: answerDrafts.get(key) } : null)
    if (!saved || !input || input.value || document.activeElement === input) continue
    input.value = saved.value
    if (!saved.focused) continue
    // Focus that moved on (to the composer, say) stays where the user put it.
    if (document.activeElement && document.activeElement !== document.body) continue
    input.focus({ preventScroll: true })
    if (saved.start != null) input.setSelectionRange(saved.start, saved.end)
  }
}

// Each card is its own keyed block: the progress line ticks on its own, and a question or dialog card is only
// redrawn when that question changes, so what is being typed into it keeps its DOM and focus.
/** Forgets what was read for a dialog that is gone: its pane shows another episode now, or none. */
function pruneRevealed() {
  for (const [pane, entry] of revealed) {
    if (agentBy(pane)?.inbox?.episode !== entry.episode) revealed.delete(pane)
  }
}

/**
 * Reads the rest of a cut permission card off Claude Code's terminal once per episode, if the transcript has not
 * brought the change by then. The server pages the view up and back under the pane's lock.
 */
function revealLater(agent) {
  if (!needsReveal(agent, state.thread)) return
  const { question, episode } = agent.inbox
  const key = cardKey(agent.inbox)
  if (revealedText(revealed.get(agent.pane), agent.inbox, key) !== undefined) return
  const entry = { episode, key, value: 'reading' }
  revealed.set(agent.pane, entry)
  const current = () => revealed.get(agent.pane) === entry
  setTimeout(async () => {
    const now = selectedAgent()
    if (!current()) return
    if (
      now?.pane !== agent.pane ||
      now.inbox?.episode !== episode ||
      cardKey(now.inbox) !== key ||
      !needsReveal(now, state.thread)
    ) {
      revealed.delete(agent.pane)
      return
    }
    let value = 'failed'
    try {
      const body = await sendAction({ op: 'revealDialog', pane: agent.pane, question, episode })
      if (body.text && body.episode === episode) value = body.text
    } catch {}
    // The dialog may have been answered meanwhile: its text then belongs to nothing on screen.
    if (!current()) return
    entry.value = value
    lastHtml = ''
    renderLive()
  }, REVEAL_AFTER_MS)
}

export function renderLive() {
  const box = $('#live')
  const agent = selectedAgent()
  pruneRevealed()
  revealLater(agent)
  const pending = agent?.kind === 'codex' && !hasBlockingDialog(agent) ? (state.thread?.meta.pending ?? []) : []
  const progress = progressCard(agent)
  const blocks = [
    ...failedBlocks(),
    { key: 'output', html: commandOutputCard() },
    { key: pending.length ? cardKey(pending[0]) : 'ask', html: asyncAskCard(pending) },
    { key: 'progress', html: progress },
    { key: agent?.inbox ? cardKey(agent.inbox) : 'dialog', html: progress ? '' : dialogCard(agent, pending.length) },
  ].filter(block => block.html)
  const html = blocks.map(block => block.key + block.html).join('')
  if (html === lastHtml) return
  lastHtml = html
  const fields = captureFields(box)
  patchKeyed(box, blocks)
  restoreFields(box, fields)
  refreshTimes(box)
  followThread()
}

/** Shows why a dialog action did not happen; a dialog that changed is redrawn from the newest state. */
function dialogActionFailed(err) {
  if (isUnauthorized(err)) return
  if (err.code === 'stale_dialog') {
    toast(t('error.stale_dialog'), '', 'error')
    lastHtml = ''
    renderLive()
    loadThread(true)
    return
  }
  toast(t('toast.actionFailed'), err.message, 'error')
}

// One answer per dialog at a time: a double click on Yes would otherwise approve the next, identical prompt too.
function runDialogAction(action, okMessage, key = `dialog:${action.pane}`) {
  return inflight.run(
    key,
    async () => {
      try {
        const body = await sendAction(action)
        toast(okMessage)
        return body
      } catch (err) {
        dialogActionFailed(err)
        return null
      }
    },
    DOUBLE_CLICK_MS,
  )
}

async function asyncAnswer(answer, form) {
  const pane = state.selected
  const action = { op: 'asyncAnswer', pane, ...answer }
  if (await runDialogAction(action, t('toast.answered'), `ask:${pane}:${answer.question}`)) {
    if (form) answerDrafts.delete(fieldKey(form.closest('[data-key]'), form))
    setTimeout(() => loadThread(true), 900)
  }
}

export const cancelDialog = () => {
  const pane = state.selected
  const cancel = () => postAction({ op: 'keys', pane, keys: ['esc'] }, t('toast.cancelled'))
  return inflight.run(`dialog:${pane}`, cancel, DOUBLE_CLICK_MS)
}

/**
 * Answers the selected agent's dialog as it was shown: `question` defaults to the dialog on screen now.
 * @param {{ key: string; label: string }} option
 * @param {{ text?: string; okMessage?: string; question?: string }} [answer]
 */
export function chooseOption(option, { text, okMessage, question } = {}) {
  const dialog = { question: question ?? selectedAgent()?.inbox?.question ?? '' }
  return runDialogAction(
    optionAction(state.selected, dialog, option, text),
    okMessage ?? (text ? t('toast.answered') : t('toast.selected')),
  )
}

async function resendFailed(card) {
  const pane = state.selected
  const text = card.querySelector('pre').textContent
  // The retry is an ordinary reply: if it fails too, it comes back as a local "not sent" card instead.
  if (card.dataset.kind === 'first') await postAction({ op: 'dismissFirstMessage', pane })
  else removeFailedSend(card.dataset.id)
  renderLive()
  sendReply(pane, text, { restore: false })
}

function editFailed(card) {
  const text = card.querySelector('pre').textContent
  const el = $('#reply-text')
  el.value = el.value.trim() ? `${el.value.replace(/\s*$/, '')}\n\n${text}` : text
  el.dispatchEvent(new Event('input'))
  el.focus()
  dismissFailed(card)
}

function dismissFailed(card) {
  if (card.dataset.kind === 'first') postAction({ op: 'dismissFirstMessage', pane: state.selected })
  else removeFailedSend(card.dataset.id)
  renderLive()
}

export function initCards() {
  const box = $('#live')
  box.addEventListener('click', e => {
    const target = e.target.closest('[data-action]')
    if (!target) return
    switch (target.dataset.action) {
      case 'async-option':
        return asyncAnswer({ question: target.dataset.question, option: target.dataset.option })
      case 'option':
        if (target.dataset.key === 'esc') return cancelDialog()
        return chooseOption(target.dataset, { question: target.closest('.ask-card')?.dataset.question ?? '' })
      case 'resend':
        return resendFailed(target.closest('.failed-card'))
      case 'edit-failed':
        return editFailed(target.closest('.failed-card'))
      case 'dismiss-failed':
        return dismissFailed(target.closest('.failed-card'))
      case 'go-terminal':
        return setView('term')
      case 'toggle-change': {
        const key = target.closest('.ask-card')?.dataset.card ?? ''
        if (expandedChanges.has(key)) expandedChanges.delete(key)
        else expandedChanges.add(key)
        return renderLive()
      }
      case 'close-output':
        state.commandOutput = null
        return renderLive()
    }
  })
  // The keyboard takes half a phone screen; bring the field being typed into back above it.
  box.addEventListener('focusin', e => {
    if (isNarrow() && e.target.matches('input')) setTimeout(() => e.target.scrollIntoView({ block: 'center' }), 320)
  })
  box.addEventListener('submit', e => {
    const form = e.target.closest('form.other-form')
    if (!form) return
    e.preventDefault()
    const value = form.querySelector('input').value.trim()
    if (!value) return
    const question = form.closest('.ask-card')?.dataset.question ?? ''
    if (form.dataset.key) chooseOption(form.dataset, { text: value, question })
    else asyncAnswer({ question, text: value }, form)
  })
  box.addEventListener('input', e => {
    const form = e.target.closest('form.other-form')
    if (!form) return
    const key = fieldKey(form.closest('[data-key]'), form)
    if (e.target.value) answerDrafts.set(key, e.target.value)
    else answerDrafts.delete(key)
  })
}
