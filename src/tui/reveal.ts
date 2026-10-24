import { OPTION_RE, RULE_RE, lines } from './screen.ts'

// Claude Code draws its permission prompt in a full-screen view that keeps what does not fit: a file or diff
// taller than the pane shows only its end, but PageUp scrolls the view up (the dialog stays open, with a
// "Jump to bottom (ctrl+End) ↓" note) and ctrl+End brings it back.
export const SCROLL_UP = '\x1b[5~'
export const SCROLL_TO_END = '\x1b[1;5F'

/** The note Claude Code overlays near the bottom of a scrolled view; rows from it down are not redrawn. */
export const JUMP_NOTE_RE = /\(ctrl\+End\)\s*↓/
/** While scrolled, the top row pins the newest prompt (`❯ …`), which is not part of the view. */
const PINNED_PROMPT_RE = /^❯\s/
const DASHES_RE = /^\s*[╌┄┈]+\s*$/
const FIRST_OPTION_RE = /^\s*[❯›▶]?\s*1[.)]\s/
const MIN_OVERLAP = 3

const trimRows = (screen: string) => lines(screen.replace(/\n+$/, ''))

/** The rows of a page scrolled up: without the pinned prompt row, cut where the jump-to-bottom note starts. */
export function scrolledRows(screen: string): string[] {
  const rows = trimRows(screen)
  if (PINNED_PROMPT_RE.test(rows[0] ?? '')) rows.shift()
  const note = rows.findIndex(row => JUMP_NOTE_RE.test(row))
  return note < 0 ? rows : rows.slice(0, note)
}

/** `upper` (scrolled further up) put in front of `lower` where they overlap; null when they do not. */
export function stitchRows(upper: string[], lower: string[]): string[] | null {
  for (let k = Math.min(upper.length, lower.length); k >= MIN_OVERLAP; k--) {
    const tail = upper.slice(upper.length - k)
    if (tail.every((row, i) => row === lower[i])) return [...upper.slice(0, upper.length - k), ...lower]
  }
  return null
}

/**
 * The whole dialog from pages of the screen: `pages[0]` as it is, each next one after another PageUp. Its text
 * runs from the title under the dialog's top rule down to the question above the options, with the preview's
 * dashed rules dropped, rows the TUI wrapped joined, and the common indent removed. Undefined while the pages
 * have not reached the top rule yet; null when there is no dialog or two pages do not overlap (the view changed
 * while it was read).
 */
export function revealedDialog(pages: string[]): string | null | undefined {
  const bottom = trimRows(pages[0] ?? '')
  let end = -1
  for (let i = bottom.length - 1; i >= 0; i--) {
    if (FIRST_OPTION_RE.test(bottom[i] ?? '') && OPTION_RE.test(bottom[i] ?? '')) {
      end = i
      break
    }
  }
  if (end < 0) return null
  let rows: string[] | null = bottom.slice(0, end)
  for (let p = 0; p < pages.length; p++) {
    if (p > 0) rows = stitchRows(scrolledRows(pages[p] ?? ''), rows)
    if (!rows) return null
    let top = -1
    for (let i = rows.length - 1; i >= 0; i--) {
      if (RULE_RE.test(rows[i] ?? '')) {
        top = i
        break
      }
    }
    if (top >= 0) return dialogText(rows.slice(top + 1), Math.max(...rows.map(r => r.length)))
  }
  return undefined
}

/** A numbered preview row: `  12 text`, or `  12 -text` / `  12 +text` in a diff. */
const NUMBERED_RE = /^\s*\d+\s/

// The TUI breaks a row too long for the pane at its right margin and goes on at the text's column, unnumbered.
function unwrap(rows: string[], width: number): string[] {
  const out: string[] = []
  let column = 0
  let open = false
  for (const row of rows) {
    const numbered = NUMBERED_RE.exec(row)
    const last = out.length - 1
    if (!numbered && open && last >= 0 && row.slice(0, column).trim() === '') {
      out[last] += row.slice(column)
    } else {
      out.push(row)
      if (numbered) column = numbered[0].length
    }
    open = (numbered || open) && row.length >= width - 4
  }
  return out
}

function dialogText(rows: string[], width: number): string {
  const kept = unwrap(
    rows.filter(row => !DASHES_RE.test(row)),
    width,
  )
  const indent = Math.min(...kept.filter(r => r.trim()).map(r => r.length - r.trimStart().length))
  const cut = Number.isFinite(indent) ? indent : 0
  return kept
    .map(r => r.slice(cut))
    .join('\n')
    .trim()
}
