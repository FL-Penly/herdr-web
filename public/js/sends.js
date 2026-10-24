// @ts-check
import { load, save } from './storage.js'

/**
 * @typedef {{ id: string; pane: string; text: string; at: number }} FailedSend
 * @typedef {{ to: 'composer'; typed: string; attachments: string[] } | { to: 'draft'; text: string } | { to: 'card' }} Recovery
 */

const MAX_PER_PANE = 10
let seq = 0

export const sendId = () => `${Date.now().toString(36)}-${++seq}`

/**
 * Where the text of a reply that failed goes back. It returns to the composer only while that pane's
 * composer is still empty: anything typed since is newer and must not be overwritten.
 * @param {{ selected: boolean; draft: string; composerAttachments: number; typed: string; attachments: string[]; text: string; restore: boolean }} o
 * @returns {Recovery}
 */
export function recoverFailedSend({ selected, draft, composerAttachments, typed, attachments, text, restore }) {
  const untouched = !draft.trim() && !(selected && composerAttachments)
  if (!restore || !untouched) return { to: 'card' }
  // Attachments live in the open composer only; another pane gets their paths back as text.
  return selected ? { to: 'composer', typed, attachments } : { to: 'draft', text }
}

/**
 * Send a reply, asking `confirm` before text left in the agent's terminal input is replaced. The resend names
 * the draft that was shown, and the server replaces only that one: when the terminal changed meanwhile it
 * answers `terminal_draft` again with the new text, which is asked about in turn.
 * @template T
 * @param {(discardDraft?: string) => Promise<T>} send
 * @param {(draft: string) => Promise<boolean>} confirm
 * @returns {Promise<{ sent: T } | { declined: true }>}
 */
export async function sendReplacingDraft(send, confirm) {
  /** @type {string | undefined} */
  let approved
  for (;;) {
    try {
      return { sent: await send(approved) }
    } catch (err) {
      if (/** @type {{ code?: string }} */ (err)?.code !== 'terminal_draft') throw err
      const draft = /** @type {{ data?: { draft?: string } }} */ (err).data?.draft ?? ''
      if (!(await confirm(draft))) return { declined: true }
      approved = draft
    }
  }
}

/** @type {FailedSend[]} */
let failed = load('failedSends', [])

const persist = () => save('failedSends', failed)

/** @param {string | null | undefined} pane */
export const failedSendsFor = pane => failed.filter(f => f.pane === pane)

/**
 * @param {string} pane
 * @param {string} text
 */
export function addFailedSend(pane, text, now = Date.now()) {
  const entry = { id: sendId(), pane, text, at: now }
  const mine = [...failedSendsFor(pane).filter(f => f.text !== text), entry].slice(-MAX_PER_PANE)
  failed = [...failed.filter(f => f.pane !== pane), ...mine]
  persist()
  return entry
}

/** @param {string} id */
export function removeFailedSend(id) {
  const kept = failed.filter(f => f.id !== id)
  if (kept.length === failed.length) return null
  const removed = failed.find(f => f.id === id) ?? null
  failed = kept
  persist()
  return removed
}

/** @param {Set<string>} livePanes */
export function pruneFailedSends(livePanes) {
  if (!livePanes.size) return
  const kept = failed.filter(f => livePanes.has(f.pane))
  if (kept.length === failed.length) return
  failed = kept
  persist()
}
