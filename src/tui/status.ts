import { findInputBox, lines } from './screen.ts'

export interface StatusLine {
  /** The busy line (`✻ Cogitating… (12s · esc to interrupt)`), spinner glyph stripped. */
  activity: string | null
  /** Context used, percent. */
  ctx: number | null
  mode: string | null
  effort: string | null
  ultra: boolean | null
  model: string | null
  /** Codex async questions waiting for an answer. */
  asks: number
  /** Background shells Claude Code still runs (`· 1 shell ·` in its footer). */
  shells: number
  /** The input box is on screen. Without it ctx and mode are hidden (by a dialog), not absent. */
  inputBox: boolean
}

const ACTIVITY_ROWS = 25
const ASKS_ROWS_ABOVE_INPUT = 8
/** Where to look for queued questions while no input box is on screen. */
const ASKS_SCAN_ROWS = 14

const ACTIVITY_RE = /esc to interrupt|esc 中断|ctrl\+c to interrupt/i
// Claude's statusline (`ctx: 19% used`) or Codex's (`Context 63% left`).
const CTX_RE = /ctx:\s*(\d+)%\s*used|Context\s+(\d+)%\s+left/i
const MODES: [RegExp, string][] = [
  [/bypass permissions on/i, 'bypass permissions'],
  [/plan mode on|Plan mode(?= \(shift\+tab)/i, 'plan mode'],
  [/accept edits on/i, 'accept edits'],
  [/auto mode on/i, 'auto mode'],
  [/manual mode on/i, 'manual mode'],
  [/YOLO mode/i, 'YOLO mode'],
]
// Codex prints its approval mode only in the session header box at the top.
const CODEX_HEADER_MODE_RE = /^[\s│]*permissions:\s+YOLO mode[\s│]*$/m
// `◐ medium · ultracode · /effort`
const EFFORT_RE = /[◔◐◑◕●○◒◓◉]\s+(low|medium|high|xhigh|max)(\s+·\s+ultracode)?\s+·\s+\/effort/
// Recent Claude Code versions print the effort indicator right-aligned on its own row just above the input box.
const RIGHT_ALIGNED_RE = /^\s{20,}\S/
const ULTRACODE_RULE_RE = /[─━]\s+ultracode\s+[─━]/
const MODEL_RE = /\[((?:Opus|Sonnet|Haiku|Fable)[^\]]*)\]/
// `? 2 questions · <title>` with `shift+← to answer` on the same or the next row.
const ASKS_RE = /\?\s+(\d+)\s+questions?\s+·[^\n]*?\n?\s*shift\+← to answer/
// `⏵⏵ bypass permissions on · 1 shell · ← 2 agents`, or `2 shells` alone on the footer row.
const SHELLS_RE = /(?:^|·)\s*(\d+)\s+shells?\s*(?:·|$)/m

/**
 * The agent's status, read only from its input box chrome (top rule and footer) so transcript text
 * cannot change it. ctx/mode/effort/model are null while a dialog replaces the input box.
 */
export function parseStatus(screen: string): StatusLine {
  const rows = lines(screen)
  const box = findInputBox(rows)
  const topRule = box && box.topRule >= 0 ? (rows[box.topRule] ?? '') : ''
  const above = box && box.topRule > 0 ? (rows[box.topRule - 1] ?? '') : ''
  const indicator = RIGHT_ALIGNED_RE.test(above) ? above : ''
  const footer = box ? rows.slice(box.end + 1).join('\n') : ''
  const chrome = box ? [indicator, topRule, footer].join('\n') : ''
  const ctxM = CTX_RE.exec(chrome)
  const effM = EFFORT_RE.exec(chrome)
  const asksFrom = box ? Math.max(0, box.prompt - ASKS_ROWS_ABOVE_INPUT) : Math.max(0, rows.length - ASKS_SCAN_ROWS)
  return {
    activity: activity(rows),
    ctx: ctxM ? (ctxM[1] != null ? Number(ctxM[1]) : 100 - Number(ctxM[2])) : null,
    mode: MODES.find(([re]) => re.test(chrome))?.[1] ?? (CODEX_HEADER_MODE_RE.test(screen) ? 'YOLO mode' : null),
    effort: effM?.[1] ?? null,
    ultra: effM ? !!effM[2] : ULTRACODE_RULE_RE.test(topRule) ? true : null,
    model: MODEL_RE.exec(chrome)?.[1] ?? null,
    asks: Number(ASKS_RE.exec(rows.slice(asksFrom).join('\n'))?.[1] ?? 0),
    shells: Number(SHELLS_RE.exec(footer)?.[1] ?? 0),
    inputBox: box !== null,
  }
}

function activity(rows: string[]): string | null {
  const recent = rows.filter(l => l.trim()).slice(-ACTIVITY_ROWS)
  for (let i = recent.length - 1; i >= 0; i--) {
    const row = recent[i]?.trim() ?? ''
    if (ACTIVITY_RE.test(row)) return row.replace(/^[^\p{L}\p{N}(]+/u, '').trim()
  }
  return null
}
