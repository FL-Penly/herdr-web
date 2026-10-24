// Pure helpers over a `herdr pane read` screen: plain text, one terminal row per line.
//
// Both TUIs draw an input box at the bottom while they accept input:
//   Claude Code   a rule, `❯` + NBSP + text (continuation rows indented two spaces), a rule, then the footer
//   Codex         `›` + text (same indentation), a blank row, then a footer whose rows contain `·`
// Dialogs and menus replace that box, so "is the box there?" is the main guard against transcript text
// that merely looks like a dialog, a footer or a menu.

/** A horizontal rule; Claude puts labels such as `ultracode` on its input box's top rule. */
export const RULE_RE = /^\s*[╭┌]?[─━▔]{8,}/
/** A numbered option row, optionally under the cursor glyph. `>` is left out: it is a markdown blockquote. */
export const OPTION_RE = /^\s*[❯›▶]?\s*(\d{1,2})[.)]\s+(.+?)\s*$/
/** A row with a prompt or cursor glyph. `\s` also matches the NBSP Claude prints after `❯`. */
export const CURSOR_RE = /^\s*[❯›](\s|$)/
/** Rows a transcript starts messages with: Claude `⏺`/`●`, thinking `✻`, Codex `•`. */
export const BULLET_RE = /^\s*[⏺●✻•]/
/** Key hints at the bottom of a menu or panel. */
export const MENU_HINT_RE = /(enter (to )?(select|confirm|submit|continue|resume)|esc (to )?(back|cancel|exit))/i
/** Hint rows of the Codex async-question panel (`enter submit  ^] skip  shift+→ main prompt  shift+← next question`). */
const ASYNC_PANEL_RE = /\^\] skip/
const MAIN_PROMPT_HINT_RE = /shift\+→ main prompt/
/** Claude Code's hint under a permission question, which is not part of the question. */
const TIP_ROW_RE = /^(?:Tip|提示)[:：].*\bauto mode\b|auto mode handles these prompts/i
const INPUT_SCAN_ROWS = 30
export const DIALOG_ROWS = 40

const BOX_GLYPHS = /[│╭╮╰╯─┃┏┓┗┛━║╔╗╚╝═]/g

export function lines(screen: string): string[] {
  return screen.split('\n').map(l => l.replace(/\s+$/, ''))
}

/** A row with box-drawing glyphs removed, so framed dialogs read like plain ones. */
export function stripBox(row: string): string {
  return row.replace(BOX_GLYPHS, '').replace(/\s+$/, '')
}

export function isRule(row: string): boolean {
  return RULE_RE.test(row)
}

export function indentOf(row: string): number {
  return row.length - row.trimStart().length
}

/** A row that looks like an input prompt or an arrow-menu cursor, but not a numbered option. */
export function isCursorRow(row: string): boolean {
  return CURSOR_RE.test(row) && !OPTION_RE.test(row)
}

function isCodexFooterRow(row: string): boolean {
  return /·|for shortcuts|\(shift\+tab/.test(row) && !MENU_HINT_RE.test(row)
}

export interface InputBox {
  prompt: number
  /** Last row of the box (Claude: its bottom rule). The footer starts below it. */
  end: number
  /** Claude's top rule, or -1 (Codex has none). */
  topRule: number
  text: string[]
}

/** The agent's input box, or null while a dialog, menu or panel replaces it. */
export function findInputBox(rows: string[]): InputBox | null {
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - INPUT_SCAN_ROWS); i--) {
    const row = rows[i] ?? ''
    if (!isCursorRow(row)) continue
    if (row.trimStart().startsWith('❯')) {
      if (!isRule(rows[i - 1] ?? '')) continue
      let bottom = i + 1
      while (bottom < rows.length && !isRule(rows[bottom] ?? '')) bottom++
      if (bottom >= rows.length) continue
      let last = bottom - 1
      while (last > i && !rows[last]?.trim()) last--
      return { prompt: i, end: bottom, topRule: i - 1, text: rows.slice(i, last + 1) }
    }
    let last = i
    while (last + 1 < rows.length && isCodexContinuation(rows[last + 1] ?? '')) last++
    if (!rows.slice(last + 1, last + 4).some(isCodexFooterRow)) continue
    return { prompt: i, end: last, topRule: -1, text: rows.slice(i, last + 1) }
  }
  return null
}

function isCodexContinuation(row: string): boolean {
  return !!row.trim() && /^\s{2}/.test(row) && !isRule(row) && !isCodexFooterRow(row)
}

export function hasInputBox(screen: string): boolean {
  return findInputBox(lines(screen)) !== null
}

/** The text currently typed into the agent's input box, one entry per screen row. */
export function inputLines(screen: string): string[] {
  const box = findInputBox(lines(screen))
  if (!box) return []
  const [first = '', ...rest] = box.text
  const out = [first.replace(/^\s*[❯›]\s?/, ''), ...rest.map(l => l.trim())]
  while (out.length && !out[out.length - 1]?.trim()) out.pop()
  while (out.length && !out[0]?.trim()) out.shift()
  return out
}

// CSI sequences (SGR and the rest) and OSC strings in `herdr pane read --ansi` output.
const ANSI_RE = /\x1b\[([0-9;:?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
// Codex draws a braille animation across its first screen, input row included.
const BRAILLE_RE = /[\u2800-\u28ff]/g

/** A row of `herdr pane read --ansi` as plain text, with whether each character is drawn dim (faint). */
function styledRow(row: string): { text: string; dim: boolean[] } {
  let text = ''
  const dim: boolean[] = []
  let faint = false
  let at = 0
  const put = (chunk: string) => {
    for (const ch of chunk) {
      text += ch
      for (let i = 0; i < ch.length; i++) dim.push(faint)
    }
  }
  for (const m of row.replace(/\r$/, '').matchAll(ANSI_RE)) {
    put(row.slice(at, m.index))
    at = m.index + m[0].length
    if (m[2] !== 'm') continue
    const params = (m[1] || '0').split(/[;:]/).map(Number)
    for (let i = 0; i < params.length; i++) {
      const n = params[i]
      if (n === 0 || n === 22) faint = false
      else if (n === 2) faint = true
      // 38/48/58;5;n and 38/48/58;2;r;g;b carry numbers that are not attributes.
      else if (n === 38 || n === 48 || n === 58) i += params[i + 1] === 5 ? 2 : 4
    }
  }
  put(row.slice(at).replace(/\r$/, ''))
  return { text, dim }
}

/** `herdr pane read --ansi` output as plain text. */
export function stripAnsi(screen: string): string {
  return screen
    .split('\n')
    .map(row => styledRow(row).text)
    .join('\n')
}

/**
 * What was typed into the agent's input box and not sent, from a screen read with `--ansi`: '' when the box is
 * empty or out of view. Both TUIs draw their placeholder (Claude's `Try "…"`, Codex's `Ask Codex to do
 * anything`, a suggested next prompt) dim, and typed text plain, so only the plain characters count.
 */
export function inputDraft(styled: string): string {
  const rows = styled.split('\n').map(styledRow)
  const box = findInputBox(lines(rows.map(r => r.text).join('\n')))
  if (!box) return ''
  const typed = rows.slice(box.prompt, box.prompt + box.text.length).map(({ text, dim }, i) => {
    const chars = [...text]
    let out = ''
    let at = 0
    for (const ch of chars) {
      if (!dim[at]) out += ch
      at += ch.length
    }
    out = out.replace(BRAILLE_RE, ' ').trimEnd()
    return i === 0 ? out.replace(/^\s*[❯›]\s?/, '') : out.trim()
  })
  return typed.join('\n').trim()
}

/**
 * The prompt text above row `from`: up to `max` non-empty rows, stopping at a transcript bullet, a rule,
 * or the second blank gap. Dashed separators (`╌╌╌`, around Claude's diff previews) and Claude's auto-mode
 * tip are skipped.
 */
export function collectPrompt(rows: string[], from: number, max: number): string {
  const above: string[] = []
  let gaps = 0
  for (let i = from - 1; i >= 0 && above.length < max; i--) {
    const raw = rows[i] ?? ''
    if (isRule(raw)) break
    const t = stripBox(raw).trim()
    if (!t) {
      if (above.length && ++gaps >= 2) break
      continue
    }
    if (BULLET_RE.test(t)) break
    if (/^[╌─━┄┈═]+$/.test(t) || TIP_ROW_RE.test(t)) continue
    above.unshift(t)
  }
  return above.join('\n')
}

export function lastLines(screen: string, n: number): string {
  return lines(screen)
    .filter(l => l.trim())
    .slice(-n)
    .join('\n')
}

/** Codex's async-question panel is open (its hints show `^] skip`). */
export function isAsyncPanelOpen(screen: string): boolean {
  return ASYNC_PANEL_RE.test(screen)
}

/** A Codex panel offers `shift+→ main prompt` to get back to the composer. */
export function hasMainPromptHint(screen: string): boolean {
  return MAIN_PROMPT_HINT_RE.test(screen)
}

/** Text with all whitespace removed, for comparing what the TUI re-wrapped. */
export function squeeze(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * Whether two renderings of a question are the same text: all of it, whatever the width it was wrapped to
 * or the frame drawn around it. The only other difference allowed is a TUI cutting a long text short with a
 * trailing `…`, and then the other side must go on from exactly what was visible up to it.
 */
export function sameText(a: string, b: string): boolean {
  const x = squeeze(a.replace(BOX_GLYPHS, ''))
  const y = squeeze(b.replace(BOX_GLYPHS, ''))
  if (x === y) return true
  const cut = (s: string) => (s.endsWith('…') ? s.slice(0, -1) : '')
  const [cx, cy] = [cut(x), cut(y)]
  return (!!cx && (cy || y).startsWith(cx)) || (!!cy && (cx || x).startsWith(cy))
}

/**
 * The newest message the user sent, as Codex echoes it in its history (`› text`, continuation rows indented),
 * found above the input box. Null without an input box or an echo in view.
 */
export function lastUserEcho(screen: string): string | null {
  const rows = lines(screen)
  const box = findInputBox(rows)
  if (!box) return null
  for (let i = box.prompt - 1; i >= 0; i--) {
    const row = rows[i] ?? ''
    if (!/^›\s\S/.test(row)) continue
    const text = [row.slice(2)]
    for (let j = i + 1; j < box.prompt && /^\s{2}\S/.test(rows[j] ?? ''); j++) text.push((rows[j] ?? '').trim())
    return text.join('\n')
  }
  return null
}
