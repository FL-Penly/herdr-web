import type { AskForm, Option } from '../protocol.ts'
import {
  BULLET_RE,
  DIALOG_ROWS,
  OPTION_RE,
  collectPrompt,
  findInputBox,
  hasInputBox,
  indentOf,
  isAsyncPanelOpen,
  isCursorRow,
  isRule,
  lines,
  stripBox,
} from './screen.ts'

export interface Dialog {
  question: string
  options: Option[]
  /** The trust-this-folder dialog, and the folder it names. */
  trust: boolean
  folder: string | null
  form?: AskForm
}

const ARROW_CURSOR_RE = /^(\s*)[❯›▶]\s+(\S.*)$/
const HINT_ROW_RE = /^(Enter to|Esc to|↑|Press|Tab to)/i
/** An option's description, indented under its label. */
const DESC_ROW_RE = /^\s{3,}\S/
const TRUST_RE = /trust this folder|Quick safety check|Do you trust|Folder access|allow Codex to work in this folder/i
/** Codex's full-screen `/resume` picker: its question is the title row, far above the list. */
const RESUME_PICKER_RE = /^\s*(Resume a previous session)\s*$/m
const ARROW_SCAN_ROWS = 20
const REGION_MAX_ROWS = 20
const MENU_PROMPT_MAX_ROWS = 8
// Without options: the last filled rows stand in for the question, and a trust notice is looked for
// in the last rows of the screen.
const FALLBACK_QUESTION_ROWS = 6
const FALLBACK_REGION_ROWS = 12

interface Located {
  question: string
  options: Option[]
  form?: AskForm
  /** The rows the dialog occupies, from its top (a rule or transcript bullet) down. */
  region: string[]
}

/**
 * The dialog at the bottom of the screen: numbered options (permission prompts, AskUserQuestion, trust,
 * Codex approvals) or an arrow-key menu, whose option keys are `nav:<offset from the cursor>`.
 * `options` is empty when there is none; `question` then falls back to the last rows on screen.
 */
export function parseDialog(screen: string): Dialog {
  const { question, options, region, form } = locate(screen)
  const trust = TRUST_RE.test(region.join('\n'))
  return { question, options, trust, folder: trust ? folderIn(region) : null, ...(form ? { form } : {}) }
}

/** The agent shows its input box and no dialog: safe to type a first message into. */
export function isReadyForInput(screen: string): boolean {
  if (!hasInputBox(screen)) return false
  const d = parseDialog(screen)
  return !d.options.length && !d.trust
}

function locate(screen: string): Located {
  // herdr ends the screen with a newline: counting that empty row would cost the dialog its top row.
  const raw = lines(screen.replace(/\n+$/, '')).slice(-DIALOG_ROWS)
  const rows = raw.map(stripBox)
  const asyncPanel = isAsyncPanelOpen(screen)
  const found = numbered(raw, rows, asyncPanel) ?? arrowMenu(raw, rows, asyncPanel)
  if (!found) return fallback(raw, rows)
  const picker = isResumePicker(screen) ? RESUME_PICKER_RE.exec(screen)?.[1] : undefined
  return picker ? { ...found, question: picker } : found
}

/** Codex's `/resume` picker, which herdr may report as `blocked` although the user opened it. */
export function isResumePicker(screen: string): boolean {
  return RESUME_PICKER_RE.test(screen) && /\benter resume\b/.test(screen)
}

// A dialog is the last thing on screen: below its options there may be descriptions, hints and rules,
// but never the input box or more transcript. This keeps a numbered list in the agent's output, with
// the input box under it, from being read as a dialog.
function endsScreen(raw: string[], from: number, asyncPanel: boolean): boolean {
  for (let i = from + 1; i < raw.length; i++) {
    const row = raw[i] ?? ''
    if (BULLET_RE.test(row)) return false
    // Codex may keep its composer on screen under the async-question panel.
    if (!asyncPanel && isCursorRow(row)) return false
  }
  return true
}

function numbered(raw: string[], rows: string[], asyncPanel: boolean): Located | null {
  let end = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (OPTION_RE.test(rows[i] ?? '')) {
      end = i
      break
    }
  }
  if (end < 0 || !endsScreen(raw, end, asyncPanel)) return null
  let start = end
  for (let i = end - 1; i >= 0; i--) {
    const row = rows[i] ?? ''
    if (OPTION_RE.test(row)) start = i
    // Blank rows (rules strip to blank) and indented descriptions may sit between options.
    else if ((!row.trim() || DESC_ROW_RE.test(row)) && rows.slice(Math.max(0, i - 3), i).some(l => OPTION_RE.test(l)))
      continue
    else break
  }
  const options: Option[] = []
  let labelCol = 0
  const width = screenWidth(raw)
  // Whether the option's text so far ends on the row above, so a row at the label's column continues it.
  let open = false
  const more = (i: number) => {
    const row = rows[i] ?? ''
    const last = options[options.length - 1]
    const wrap =
      open && last && !last.desc && indentOf(row) === labelCol ? wrapJoin(rows[i - 1] ?? '', row, width) : null
    if (last && wrap !== null) last.label += wrap + row.trim()
    else describe(last, row)
    open = wrap !== null
  }
  for (let i = start; i <= end; i++) {
    const row = rows[i] ?? ''
    const m = OPTION_RE.exec(row)
    if (m) {
      labelCol = row.indexOf(m[2] ?? '')
      const o = option(m[1] ?? '', m[2] ?? '', /^\s*[❯›▶]/.test(row))
      options.push(o)
      open = !o.desc
    } else if (!isRule(raw[i] ?? '') && DESC_ROW_RE.test(row)) {
      more(i)
    } else open = false
  }
  for (let i = end + 1; i < rows.length; i++) {
    const row = rows[i] ?? ''
    if (!row.trim() || isRule(raw[i] ?? '') || indentOf(row) < labelCol || HINT_ROW_RE.test(row.trim())) break
    more(i)
  }
  // All of the prompt in view, not its last rows: a click is checked against every row the browser showed,
  // the top of a long command included.
  const question = collectPrompt(raw, start, DIALOG_ROWS)
  const form = askForm(rows, start, question)
  return { question: form?.question ?? question, options, region: region(raw, rows, start), form: form?.form }
}

/** The tab row above each question of a multi-question AskUserQuestion: `←  ☐ Color  ☒ Fruit  ✔ Submit  →`. */
const FORM_TABS_RE = /^\s*←\s+(.*?)\s+→\s*$/
const FORM_TAB_RE = /([☐☒✔])\s+(.+?)(?=\s+[☐☒✔]\s|$)/g
const REVIEW_QUESTION_RE = /^\s*●\s+(.*)$/
const REVIEW_ANSWER_RE = /^\s*→\s+(.*)$/
const FORM_SCAN_ROWS = 30

/**
 * Claude Code asks several questions as tabs, then a submit tab that reviews the answers: nothing reaches
 * Claude until that is confirmed. The question leaves out the tab row; on the submit tab it is the answers
 * (`question → answer` each) and the ask under them, since the review rows stop the prompt at their bullets.
 */
function askForm(rows: string[], start: number, prompt: string): { question: string; form: AskForm } | null {
  let tabs = -1
  for (let i = start - 1; i >= Math.max(0, start - FORM_SCAN_ROWS) && tabs < 0; i--)
    if (FORM_TABS_RE.test(rows[i] ?? '')) tabs = i
  if (tabs < 0) return null
  const items = [...(FORM_TABS_RE.exec(rows[tabs] ?? '')?.[1] ?? '').matchAll(FORM_TAB_RE)]
  const steps = items.filter(m => m[1] !== '✔').map(m => ({ label: (m[2] ?? '').trim(), done: m[1] === '☒' }))
  if (!steps.length) return null
  const review: { question: string; answer: string }[] = []
  let after = tabs + 1
  for (let i = tabs + 1; i < start; i++) {
    const row = rows[i] ?? ''
    const q = REVIEW_QUESTION_RE.exec(row)
    const a = REVIEW_ANSWER_RE.exec(row)
    const last = review[review.length - 1]
    if (q) review.push({ question: (q[1] ?? '').trim(), answer: '' })
    else if (a && last) last.answer = (a[1] ?? '').trim()
    // A long question or answer wraps onto indented rows.
    else if (last && row.trim() && indentOf(row) > 0) {
      if (last.answer) last.answer += ` ${row.trim()}`
      else last.question += ` ${row.trim()}`
    } else continue
    after = i + 1
  }
  if (!review.length) {
    const question = prompt
      .split('\n')
      .filter(l => !FORM_TABS_RE.test(l))
      .join('\n')
    return { question, form: { steps, review: null } }
  }
  const ask = rows.slice(after, start).flatMap(r => (r.trim() ? [r.trim()] : []))
  return { question: [...review.map(r => `${r.question} → ${r.answer}`), ...ask].join('\n'), form: { steps, review } }
}

function arrowMenu(raw: string[], rows: string[], asyncPanel: boolean): Located | null {
  const box = findInputBox(raw)
  let at = -1
  // Filled rows only: a full-screen picker (Codex `/resume`) leaves a tall gap above its footer.
  for (let i = rows.length - 1, filled = 0; i >= 0 && filled < ARROW_SCAN_ROWS; i--) {
    if (!rows[i]?.trim()) continue
    filled++
    if (i !== box?.prompt && ARROW_CURSOR_RE.test(rows[i] ?? '')) {
      at = i
      break
    }
  }
  if (at < 0) return null
  const indent = ARROW_CURSOR_RE.exec(rows[at] ?? '')?.[1]?.length ?? 0
  const isItem = (l: string) => {
    if (!l.trim() || HINT_ROW_RE.test(l.trim())) return false
    const lead = indentOf(l)
    return ARROW_CURSOR_RE.test(l) || (lead >= indent && lead <= indent + 3)
  }
  let a = at
  let b = at
  while (a > 0 && isItem(rows[a - 1] ?? '') && !/[?？:：]$/.test(rows[a - 1]?.trim() ?? '')) a--
  while (b < rows.length - 1 && isItem(rows[b + 1] ?? '')) b++
  if (b === a || !endsScreen(raw, b, asyncPanel)) return null
  const options = rows.slice(a, b + 1).map((l, i) => {
    const offset = i - (at - a)
    return option(`nav:${offset}`, l.replace(/^\s*[❯›▶]?\s*/, ''), offset === 0)
  })
  return { question: collectPrompt(raw, a, MENU_PROMPT_MAX_ROWS), options, region: region(raw, rows, a) }
}

function fallback(raw: string[], rows: string[]): Located {
  const tail = rows.filter(l => l.trim()).slice(-FALLBACK_QUESTION_ROWS)
  return { question: tail.join('\n').trim(), options: [], region: region(raw, rows, raw.length - FALLBACK_REGION_ROWS) }
}

function option(key: string, text: string, current: boolean): Option {
  const [label = '', ...desc] = text.trim().split(/\s{2,}/)
  return { key, label, ...(desc.length ? { desc: desc.join(' ') } : {}), ...(current ? { current: true } : {}) }
}

// Full-width rules give the terminal's width; a pane read never returns longer rows.
function screenWidth(raw: string[]): number {
  return raw.reduce((w, r) => Math.max(w, r.length), 0)
}

/**
 * How a row joins the one above when the TUI wrapped a long label onto it (Claude's "Yes, allow reading
 * from <dir> during this session"): '' for a word broken at the right edge, ' ' for a wrap at a space, null
 * when the row above ended early, so this row is a description.
 */
function wrapJoin(above: string, row: string, width: number): string | null {
  if (above.length >= width) return ''
  const word = row.trim().split(/\s/, 1)[0] ?? ''
  return above.length + 1 + word.length > width ? ' ' : null
}

function describe(o: Option | undefined, row: string) {
  if (!o) return
  o.desc = o.desc ? `${o.desc} ${row.trim()}` : row.trim()
}

function region(raw: string[], rows: string[], first: number): string[] {
  let top = Math.max(0, first)
  while (
    top > 0 &&
    first - top < REGION_MAX_ROWS &&
    !isRule(raw[top - 1] ?? '') &&
    !BULLET_RE.test(rows[top - 1] ?? '')
  )
    top--
  return rows.slice(top)
}

// Claude prints the folder on a line of its own; Codex says "You are running Codex in <folder>".
function folderIn(region: string[]): string | null {
  for (const row of region) {
    const bare = /^\s*([~/]\S*)\s*$/.exec(row)?.[1]
    if (bare) return bare
  }
  for (const row of region) {
    const inline = /\bin\s+([~/]\S*?)[.:]?\s*$/.exec(row)?.[1]
    if (inline) return inline
  }
  return null
}
