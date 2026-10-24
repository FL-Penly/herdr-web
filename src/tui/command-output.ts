import { CURSOR_RE, lines } from './screen.ts'

// After a slash command such as `/context`, the TUI echoes `❯ /context` into the transcript and prints the
// output under it, indented behind `⎿`, until the input box (a rule or a prompt row) starts again.
// Output can mention the command too (`   /context all to expand`), so an echo is unindented or behind a prompt.
const ECHO_RE = /^(?:\s*[❯›>]\s*)?\//
// Unlike RULE_RE, a box top (`╭───`) does not end the output: commands may draw boxes.
const END_RE = /^\s*[─━▔]{8,}/
// `✢ Prestidigitating…`: the agent is busy (still running the command, or working on after it); not output.
const SPINNER_RE = /^\s*[^\p{L}\p{N}\s]\s+\p{L}+…/u

/** What `command` printed on `screen` (`herdr pane read --source visible`), or null if nothing yet. */
export function slashCommandOutput(screen: string, command: string): string | null {
  const rows = lines(screen)
  let at = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] ?? ''
    if (echoedCommand(row) === command) {
      at = i
      break
    }
  }
  if (at < 0) return null
  const out: string[] = []
  for (const row of rows.slice(at + 1)) {
    if (END_RE.test(row) || CURSOR_RE.test(row) || SPINNER_RE.test(row)) break
    out.push(row.replace(/^\s{0,2}⎿\s?/, ''))
  }
  const text = out.join('\n').replace(/^\n+|\n+$/g, '')
  return text || null
}

function echoedCommand(row: string): string | null {
  if (!ECHO_RE.test(row)) return null
  return (
    row
      .trim()
      .replace(/^[❯›>]\s*/, '')
      .split(/\s/)[0] ?? null
  )
}
