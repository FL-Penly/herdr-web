/**
 * A pane title worth showing: herdr's terminal title without the agent's own decorations
 * (`[x] `, `Action Required | `, a trailing ` | <dir>`), or '' when it just names the program.
 */
export function cleanTitle(raw: string, cwd: string): string {
  if (/^(claude|codex|node)(\s|$)/.test(raw.trim())) return ''
  let t = raw
    .trim()
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/^Action Required\s*\|\s*/i, '')
  const dir = cwd.split('/').filter(Boolean).pop()
  if (dir && t.endsWith(` | ${dir}`)) t = t.slice(0, -(dir.length + 3))
  return t.trim()
}
