// @ts-check
import { compactNumber, duration, terminalTitle } from './format.js'
import { hasKey, locale, t } from './i18n/index.js'
import { commandSourceKey } from './model.js'

/** @typedef {import('../../src/protocol.ts').InboxEntry} InboxEntry */
/** @typedef {import('../../src/protocol.ts').ToolItem} ToolItem */
/** @typedef {import('../../src/protocol.ts').NoteItem} NoteItem */
/** @typedef {import('../../src/protocol.ts').Command} Command */
/** @typedef {import('../../src/protocol.ts').TerminalView} TerminalView */

/**
 * @param {TerminalView | null | undefined} terminal
 * @param {string} home
 */
export const terminalLabel = (terminal, home) => terminalTitle(terminal, home) || t('terminal.untitled')

/** @param {InboxEntry} inbox */
export const inboxReasonLabel = inbox => t(`inbox.reason.${inbox.reason}`)

/**
 * One line for toasts and notifications.
 * @param {InboxEntry} inbox
 */
export function inboxSummary(inbox) {
  if (inbox.source === 'asks') return t('inbox.asks', { n: inbox.asks ?? 1 })
  if (inbox.reason === 'trust') return t('inbox.trust.title')
  return inbox.question || (inbox.message || '').replace(/\s+/g, ' ').slice(-120)
}

/** @param {ToolItem} item */
export function toolLabel(item) {
  if (item.tool === 'other' && item.name) return item.name
  const key = `tool.${item.tool}.${item.op}`
  if (hasKey(key)) return t(key)
  if (hasKey(`tool.${item.tool}`)) return t(`tool.${item.tool}`)
  return item.name || item.tool
}

/**
 * @param {NoteItem} note
 * @returns {{ text: string; tone: 'ok' | 'plain' | 'output' }}
 */
export function noteText(note) {
  switch (note.code) {
    case 'goal.complete': {
      const g = note.goal
      const stats = [
        t('note.goalComplete'),
        g?.secs != null ? duration(g.secs * 1000) : '',
        g?.turns ? t('note.turns', { n: g.turns }) : '',
        g?.tokens ? t('note.tokens', { n: compactNumber(g.tokens, locale()) }) : '',
      ]
      const head = stats.filter(Boolean).join(' · ')
      return { text: note.text ? `${head}\n${note.text}` : head, tone: 'ok' }
    }
    case 'goal.paused':
      return { text: t('note.goalPaused'), tone: 'plain' }
    case 'goal.cleared':
      return { text: t('note.goalCleared'), tone: 'plain' }
    case 'goal.status':
      return { text: t('note.goalStatus', { status: note.text ?? '' }), tone: 'plain' }
    default:
      return { text: note.text ?? '', tone: 'output' }
  }
}

/**
 * Built-in commands get a translated description when the locale has one.
 * @param {Command} command
 * @param {string} kind
 */
export function commandDescription(command, kind) {
  if (command.origin === 'builtin') {
    const key = `cmd.${kind}.${command.name}`
    if (hasKey(key)) return t(key)
  }
  return command.desc
}

/** @param {Command} command */
export const commandSourceLabel = command => t(`source.${commandSourceKey(command)}`)

/**
 * One line for a run of tool calls, as the TUIs print it: `Ran 3 shell commands, read 2 files`.
 * @param {[string, number][]} counts from runCounts
 */
export function runSummary(counts) {
  const parts = counts.map(([tool, n]) => t(hasKey(`run.${tool}`) ? `run.${tool}` : 'run.other', { n }))
  const text = parts.join(t('run.separator'))
  return text.charAt(0).toLocaleUpperCase(locale()) + text.slice(1)
}
