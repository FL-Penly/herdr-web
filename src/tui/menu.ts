import type { Option } from '../protocol.ts'
import { parseDialog } from './dialog.ts'
import { MENU_HINT_RE, findInputBox, lines } from './screen.ts'

export type Menu = { kind: 'menu'; question: string; options: Option[] } | { kind: 'panel'; text: string }

const HINT_ROWS = 4
// A panel's text starts below its full-width top rule; shorter rules are separators inside the text.
const PANEL_RULE_RE = /^\s*[▔─━]{20,}/
const PANEL_HINT_ROW_RE = /^\s*(enter|esc)\b.*(select|confirm|cancel|back)/i

/**
 * Something the user opened in the TUI that does not make herdr report `blocked`: a menu (`/model`,
 * `/resume`, …) or a read-only panel (`/status`, `/cost`, …). Both end with Enter/Esc key hints.
 */
export function parseMenu(screen: string): Menu | null {
  const rows = lines(screen)
  const filled = rows.map((row, i) => ({ row, i })).filter(r => r.row.trim())
  const hint = filled
    .slice(-HINT_ROWS)
    .reverse()
    .find(r => MENU_HINT_RE.test(r.row))
  if (!hint) return null
  // Claude replaces its input box with the menu; a hint above the box is transcript text.
  const box = findInputBox(rows)
  if (box && (box.topRule >= 0 || hint.i < box.prompt)) return null
  const d = parseDialog(screen)
  if (d.options.length >= 2 && d.options.some(o => o.current))
    return { kind: 'menu', question: d.question, options: d.options }
  let start = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    if (PANEL_RULE_RE.test(rows[i] ?? '')) {
      start = i + 1
      break
    }
  }
  const text = rows
    .slice(start)
    .filter(l => !PANEL_HINT_ROW_RE.test(l.trim()))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .replace(/\n{3,}/g, '\n\n')
  return text ? { kind: 'panel', text } : null
}
