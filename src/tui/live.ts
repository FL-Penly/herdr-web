import { findInputBox, lines } from './screen.ts'

// The reply an agent is writing, read off its screen: the transcript gets a message only once it is
// complete, while the TUI shows it as it streams. Claude Code draws the message being written in a region it
// redraws (scrollback does not hold it), so a long reply may start above the screen.

export const MAX_LIVE_BYTES = 8 * 1024
export const ELLIPSIS = '…'

const ECHO_RE = { claude: /^❯[\s ]\S/, codex: /^›\s\S/ }
const BULLET_RE = { claude: /^[⏺●]\s/, codex: /^•\s/ }
// `✶ Twisting…`, `✻ Thinking… (8s · ↓ 69 tokens)`, `✻ Brewed for 8s · done 10:00 AM`, and the tip under it.
const CLAUDE_CHROME_RE = /^[·✢✳✶✻✽*]\s+\S.*(…|\bfor \d+[smh]\b)|^\s+⎿\s+(Tip|提示)[:：]|^\s{20,}\S/
// `• Working (6s • esc to interrupt)`, `Worked for 22s • 9:55 AM` (also drawn as a labelled rule).
const CODEX_CHROME_RE = /^[•◦]\s+(Working|Thinking|Starting|Waiting for background)\b.*\(|^[\s─]*Worked for \d/
// Tool calls: Claude `Bash(…)`, `Read 1 file (ctrl+o to expand)`, with output under `⎿`; Codex `Ran …`,
// `Explored`, with details under `└`/`│`.
const CLAUDE_TOOL_HEAD_RE = /^[\w.-]+(\s-\s[\w.-]+)?(\s\(MCP\))?\(|\(ctrl\+o to expand\)\s*$/
const CLAUDE_TOOL_ROW_RE = /^\s+⎿/
const CODEX_TOOL_HEAD_RE =
  /^(Ran|Running|Explored|Exploring|Edited|Editing|Added|Deleted|Called|Calling|Updated Plan|Proposed Plan|Waited|Waiting for|Questions|Searched|Searching|Viewed|Read|Reading)\b/
const CODEX_TOOL_ROW_RE = /^\s+[└│]/
// A session's welcome header: with no prompt in view, the screen may show it rather than a reply.
const BANNER_RE = /^\s*(>_ OpenAI Codex|[▐▝▘▛▜]|[╭╰]|To get started,)/
const LIST_RE = /^\s*([-*+•]|\d{1,3}[.)])\s/

type Kind = keyof typeof ECHO_RE

/**
 * The assistant text at the bottom of the agent's transcript area, as markdown-ish plain text: the last
 * message block after the user's newest prompt, when nothing (a tool call) came after it. Starts with `…`
 * when its beginning is above the screen. Null without an input box (a dialog is up) or without such text.
 */
export function parseLive(kind: Kind, screen: string): string | null {
  const rows = lines(screen)
  const box = findInputBox(rows)
  if (!box) return null
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0)
  const area = rows.slice(0, kind === 'claude' ? box.topRule : box.prompt)
  const chrome = kind === 'claude' ? CLAUDE_CHROME_RE : CODEX_CHROME_RE
  while (area.length && (!area[area.length - 1]?.trim() || chrome.test(area[area.length - 1] ?? ''))) area.pop()

  let start = 0
  let cut = false
  let echo = findLast(area, r => ECHO_RE[kind].test(r))
  // Codex pins the prompt of the turn in view to the top row, cut short with `…`, right above that turn's
  // output: the turn starts there, but the reply's beginning may be above it.
  if (echo === 0 && kind === 'codex' && /…$/.test(area[0] ?? '') && area[1]?.trim()) {
    start = 1
    echo = -1
  } else if (echo >= 0) {
    start = echo + 1
    while (start < area.length && /^ {2}\S/.test(area[start] ?? '') && !isRuleRow(area[start] ?? '')) start++
  }
  const body = area.slice(start)
  const bullet = findLast(body, r => BULLET_RE[kind].test(r))
  let block: string[]
  if (bullet >= 0) block = body.slice(bullet)
  else if (echo < 0 && body.some(r => r.trim()) && !body.some(r => BANNER_RE.test(r))) {
    block = body
    cut = true
  } else return null
  if (isTool(kind, block)) return null

  const [head = '', ...rest] = block
  const text = [cut ? head : head.replace(BULLET_RE[kind], '  '), ...rest].map(r => r.replace(/^ {2}/, ''))
  let out = unwrap(tables(text), width - 2)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!out) return null
  if (Buffer.byteLength(out) > MAX_LIVE_BYTES) {
    out = tail(out, MAX_LIVE_BYTES)
    cut = true
  }
  return cut ? `${ELLIPSIS}\n\n${out}` : out
}

function isRuleRow(row: string): boolean {
  return /^\s*[━─]{3,}/.test(row)
}

function findLast(rows: string[], test: (r: string) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i--) if (test(rows[i] ?? '')) return i
  return -1
}

function isTool(kind: Kind, block: string[]): boolean {
  const head = (block[0] ?? '').replace(BULLET_RE[kind], '').trim()
  return kind === 'claude'
    ? CLAUDE_TOOL_HEAD_RE.test(head) || block.some(r => CLAUDE_TOOL_ROW_RE.test(r))
    : CODEX_TOOL_HEAD_RE.test(head) || block.slice(1).some(r => CODEX_TOOL_ROW_RE.test(r))
}

function tail(text: string, bytes: number): string {
  const buf = Buffer.from(text)
  const rest = buf
    .subarray(buf.length - bytes)
    .toString('utf8')
    .replace(/^�+/, '')
  const nl = rest.indexOf('\n')
  return (nl >= 0 ? rest.slice(nl + 1) : rest).trim()
}

// ── Tables ───────────────────────────────────────────────────────────────────
// Claude draws `┌─┬─┐ │ a │ b │ ├─┼─┤ └─┴─┘`; Codex underlines the header with `━━━` runs and separates rows
// with `───` runs, columns two spaces apart. Both become markdown tables; a cell wrapped over several rows
// is joined. A table whose header is above the screen gets an empty header.

const BOX_BORDER_RE = /^\s*[┌├└╞╘╒][─━┬┼┴═╪╤╧]+[┐┤┘╡╛╕]\s*$/
const BOX_ROW_RE = /^\s*│.*│\s*$/
const RULE_RUNS_RE = /^\s*[━─]+(\s{2,}[━─]+)+\s*$/

function tables(rows: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < rows.length; ) {
    const row = rows[i] ?? ''
    if (BOX_BORDER_RE.test(row) || BOX_ROW_RE.test(row)) {
      let j = i
      while (j < rows.length && (BOX_BORDER_RE.test(rows[j] ?? '') || BOX_ROW_RE.test(rows[j] ?? ''))) j++
      out.push(...boxTable(rows.slice(i, j)))
      i = j
    } else if (RULE_RUNS_RE.test(row) || (row.trim() && RULE_RUNS_RE.test(rows[i + 1] ?? ''))) {
      // A header row is underlined with `━`; a data row right above a `─` rule means the header is off screen.
      const headed = !RULE_RUNS_RE.test(row) && /━/.test(rows[i + 1] ?? '')
      const rule = RULE_RUNS_RE.test(row) ? row : (rows[i + 1] ?? '')
      let j = i + 1
      while (j < rows.length && (rows[j] ?? '').trim()) j++
      out.push(...ruleTable(headed ? row : null, rule, rows.slice(headed ? i + 2 : i, j)))
      i = j
    } else {
      out.push(row)
      i++
    }
  }
  return out
}

function boxTable(rows: string[]): string[] {
  const records: string[][] = []
  let open = false
  let headed = false
  for (const row of rows) {
    if (BOX_BORDER_RE.test(row)) {
      if (/^\s*[┌╒]/.test(row)) headed = true
      open = false
      continue
    }
    const cells = row
      .trim()
      .slice(1, -1)
      .split('│')
      .map(c => c.trim())
    addRecord(records, cells, open)
    open = true
  }
  return markdownTable(records, headed)
}

function ruleTable(header: string | null, rule: string, rows: string[]): string[] {
  const spans = [...rule.matchAll(/[━─]+/g)].map(m => [
    col(rule, m.index ?? 0),
    col(rule, (m.index ?? 0) + m[0].length),
  ])
  const split = (row: string) =>
    spans.map(([a = 0], k) => sliceCols(row, a, spans[k + 1]?.[0] ?? Number.POSITIVE_INFINITY).trim())
  const records: string[][] = header ? [split(header)] : []
  let open = false
  for (const row of rows) {
    if (RULE_RUNS_RE.test(row)) {
      open = false
      continue
    }
    addRecord(records, split(row), open)
    open = true
  }
  return markdownTable(records, header !== null)
}

/** A new table row, or, while no separator came since the last one, more of its wrapped cells. */
function addRecord(records: string[][], cells: string[], continues: boolean): void {
  const last = records[records.length - 1]
  if (!continues || !last) {
    records.push(cells)
    return
  }
  cells.forEach((c, k) => {
    const prev = last[k] ?? ''
    last[k] = prev && c ? `${prev} ${c}` : prev || c
  })
}

function markdownTable(records: string[][], headed: boolean): string[] {
  const n = Math.max(1, ...records.map(r => r.length))
  const line = (cells: string[]) =>
    `| ${Array.from({ length: n }, (_, k) => (cells[k] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
  const [head, ...body] = headed ? records : [[], ...records]
  return ['', line(head ?? []), `|${' --- |'.repeat(n)}`, ...body.map(line), '']
}

/** Terminal columns a character takes: CJK and fullwidth forms take two. */
function charWidth(cp: number): number {
  return (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2
    : 1
}

function col(row: string, index: number): number {
  let w = 0
  for (const ch of row.slice(0, index)) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

function sliceCols(row: string, from: number, to: number): string {
  let w = 0
  let out = ''
  for (const ch of row) {
    if (w >= from && w < to) out += ch
    w += charWidth(ch.codePointAt(0) ?? 0)
  }
  return out
}

/** Rejoins prose the TUI wrapped at the screen edge, leaving lists, tables and short lines alone. */
function unwrap(rows: string[], width: number): string[] {
  const out: string[] = []
  let prevWidth = 0
  for (const row of rows) {
    const prev = out[out.length - 1] ?? ''
    const word = row.trim().split(/\s/, 1)[0] ?? ''
    const wrapped =
      prev.trim() &&
      row.trim() &&
      !prev.startsWith('|') &&
      !row.startsWith('|') &&
      !LIST_RE.test(row) &&
      prevWidth + 1 + col(word, word.length) > width
    if (wrapped) out[out.length - 1] = `${prev} ${row.trim()}`
    else out.push(row)
    prevWidth = col(row, row.length)
  }
  return out
}

/**
 * Whether `live` still says something the transcript's newest turn does not: compared on letters and digits
 * only, since the screen shows rendered markdown.
 */
export function isUnseen(live: string, texts: string[]): boolean {
  const key = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, '')
  const k = key(live)
  if (!k) return false
  return !texts.some(t => key(t).includes(k))
}
