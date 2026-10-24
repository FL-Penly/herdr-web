// @ts-check
import { postAction } from './api.js'
import { $, esc, icon, setHtml } from './dom.js'
import { uploadParts } from './format.js'
import { t } from './i18n/index.js'
import { toast } from './notify.js'
import { state } from './state.js'

/** @typedef {import('../../src/protocol.ts').ReplyQueue} ReplyQueue */

/** @param {string | null} pane */
export const queueOf = pane => state.replyQueues.find(q => q.pane === pane) ?? null

/**
 * Put a message in the queue the server sends from once the turn ends; false when it was refused.
 * @param {string} pane
 * @param {string} text
 */
export async function queueReply(pane, text) {
  return (await postAction({ op: 'queueReply', pane, text })) !== null
}

/** @param {ReplyQueue | null} queue */
function status(queue) {
  if (!queue) return ''
  if (queue.held === 'send_failed') return t('queue.failed')
  if (queue.held === 'maybe_sent') return t('queue.maybeSent')
  if (queue.held === 'session_changed') return t('queue.sessionChanged')
  if (queue.held === 'terminal_input') return t('queue.terminalInput')
  if (queue.paused) return t('queue.paused')
  if (queue.held === 'terminal_draft') return t('queue.heldDraft')
  return t('queue.waiting')
}

/** The messages waiting for the selected agent's turn to end, above the composer. */
export function renderQueue() {
  const queue = queueOf(state.selected)
  const el = $('#reply-queue')
  el.hidden = !queue?.items.length
  if (!queue?.items.length) return el.replaceChildren()
  const stopped = queue.paused || queue.held === 'send_failed'
  const head = `<div class="queue-head"><span class="queue-title">${esc(t('queue.title', { n: queue.items.length }))}</span><span class="queue-status${stopped || queue.held ? ' is-held' : ''}" title="${esc(queue.detail ?? '')}">${esc(status(queue))}</span>${stopped ? `<button type="button" class="btn btn-sm btn-ghost" data-queue="resume">${esc(t('queue.resume'))}</button>` : ''}</div>`
  const items = queue.items
    .map(item => {
      const { text, files } = uploadParts(item.text)
      const shown = [text.replace(/\s+/g, ' ').trim(), ...files.map(f => f.name)].filter(Boolean).join(' · ')
      return `<li class="queue-item" data-id="${esc(item.id)}"><span class="queue-text" title="${esc(item.text)}">${esc(shown)}</span><button type="button" class="icon-btn icon-btn-sm" data-queue="now" aria-label="${esc(t('queue.sendNow'))}" title="${esc(t('queue.sendNow'))}">${icon('up')}</button><button type="button" class="icon-btn icon-btn-sm" data-queue="edit" aria-label="${esc(t('queue.edit'))}" title="${esc(t('queue.edit'))}">${icon('line')}</button><button type="button" class="icon-btn icon-btn-sm" data-queue="remove" aria-label="${esc(t('queue.remove'))}" title="${esc(t('queue.remove'))}">${icon('x')}</button></li>`
    })
    .join('')
  setHtml(el, `${head}<ol class="queue-items">${items}</ol>`)
}

/**
 * @param {{ sendNow: (pane: string, text: string) => void; edit: (pane: string, text: string) => void }} composer
 *   what to do with a message taken out: send it into the running turn, or put it back in the composer
 */
export function initQueue(composer) {
  $('#reply-queue').addEventListener('click', async e => {
    const button = /** @type {HTMLElement} */ (e.target).closest('[data-queue]')
    const pane = state.selected
    if (!button || !pane) return
    const action = button.getAttribute('data-queue')
    if (action === 'resume') return void postAction({ op: 'resumeQueue', pane })
    const id = button.closest('[data-id]')?.getAttribute('data-id')
    const item = queueOf(pane)?.items.find(i => i.id === id)
    if (!id || !item) return
    const taken = await postAction({ op: 'unqueueReply', pane, id })
    if (!taken) return
    // The server sent it while the click was on its way.
    if (taken.sent) return toast(t('queue.alreadySent'))
    if (action === 'now') composer.sendNow(pane, item.text)
    else if (action === 'edit') composer.edit(pane, item.text)
  })
}
