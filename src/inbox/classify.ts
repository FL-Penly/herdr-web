import { isIdle } from '../herdr.ts'
import type { AgentStatus, InboxEntry, InboxReason } from '../protocol.ts'
import type { Dialog, Menu } from '../tui/index.ts'

/** An idle agent's trailing question stops counting as waiting after this long. */
export const QUESTION_WINDOW_MS = 12 * 3600_000

const NO_DIALOG: Dialog = { question: '', options: [], trust: false, folder: null }
const PERMISSION_RE = /(proceed|allow|permission|approve|允许|批准|Do you want to|wants to)/i
// A last line that ends like a question: `?`, possibly inside closing markdown or brackets.
const QUESTION_MARK_RE = /[?？]\s*[*_`)）」"”]*\s*$/
const STATEMENT_END_RE = /[.。!！]\s*[*_`)）」"”]*\s*$/
// Without a question mark, the last sentence asks only when it opens a clause with an offer or a choice
// ("Want me to push", "Tests pass, should I merge") or ends in 可以吗/行吗/好吗.
const SENTENCE_BREAK_RE = /[.!]\s+|[。！]/
const ASKING_RE =
  /(^|[,，:：]\s*)(should I|shall I|(do you )?want me to|which (one|option)|要不要|是否需要我)|(可以吗|行吗|好吗)$/i

export interface Reply {
  text: string
  /** 0 when read off the screen. */
  at: number
  source: 'transcript' | 'screen'
}

export interface ClassifyInput {
  status: AgentStatus
  asks: number
  /** A menu or panel the user opened (read while idle/done, and for Codex's `/resume` picker while blocked). */
  menu: Menu | null
  /** The dialog on screen (read only while blocked). */
  dialog: Dialog | null
  /** Read only while idle/done. */
  reply: Reply | null
  cwd: string
  acked: boolean
  snoozedUntil: number | null
  now: number
}

/**
 * Why the agent wants attention, if it does. In priority order: a menu/panel the user opened; Codex
 * questions queued while it works; the blocking dialog; the last reply of a finished turn (a question
 * if it ends like one); an idle agent's recent question. Menus and queued questions cannot be acked.
 */
export function classify(i: ClassifyInput): InboxEntry | null {
  const base = { question: '', options: [], message: '', snoozedUntil: null }
  const idle = isIdle(i.status)
  if ((idle || i.status === 'blocked') && i.menu?.kind === 'menu')
    return { ...base, reason: 'choice', source: 'menu', question: i.menu.question, options: i.menu.options }
  if (idle && i.menu?.kind === 'panel') return { ...base, reason: 'blocked', source: 'panel', question: i.menu.text }
  if (i.status === 'working' && i.asks) return { ...base, reason: 'question', source: 'asks', asks: i.asks }
  if (i.status === 'working' || i.status === 'unknown' || i.acked) return null
  const snoozed = { snoozedUntil: i.snoozedUntil }
  if (i.status === 'blocked') {
    const d = i.dialog ?? NO_DIALOG
    if (i.asks && !d.options.length) return { ...base, ...snoozed, reason: 'question', source: 'asks', asks: i.asks }
    const reason = dialogReason(d)
    const entry = {
      ...base,
      ...snoozed,
      reason,
      source: 'dialog' as const,
      question: d.question,
      options: d.options,
      ...(d.form ? { form: d.form } : {}),
    }
    // The trust card words its own body, but the question still goes back with a click to prove the dialog.
    return reason === 'trust' ? { ...entry, folder: d.folder ?? i.cwd } : entry
  }
  const reply = i.reply ?? { text: '', at: 0, source: 'screen' as const }
  const asked = !!reply.text && endsWithQuestion(reply.text)
  const entry = { ...base, ...snoozed, source: reply.source, message: reply.text }
  if (i.status === 'done') return { ...entry, reason: asked ? 'question' : 'done' }
  if (asked && (!reply.at || i.now - reply.at < QUESTION_WINDOW_MS)) return { ...entry, reason: 'question' }
  return null
}

function dialogReason(d: Dialog): Extract<InboxReason, 'permission' | 'trust' | 'choice' | 'blocked'> {
  if (d.trust) return 'trust'
  if (!d.options.length) return 'blocked'
  return PERMISSION_RE.test(d.question + d.options.map(o => o.label).join(' ')) ? 'permission' : 'choice'
}

export function endsWithQuestion(text: string): boolean {
  const last =
    text
      .split('\n')
      .filter(l => l.trim())
      .pop()
      ?.trim() ?? ''
  if (QUESTION_MARK_RE.test(last)) return true
  if (STATEMENT_END_RE.test(last)) return false
  const sentence = last.split(SENTENCE_BREAK_RE).pop()?.trim() ?? ''
  return ASKING_RE.test(sentence)
}
