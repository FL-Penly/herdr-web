// @ts-check

// `src/a.ts:12`, `src/a.ts:12:4`, `src/a.ts#L12` or `#L12-L20`: the file and the line to show.
const LOCATION = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/
// A path as agents write one: `~/x`, `./x`, `/abs/x` or `dir/file.ext`, optionally with a line. A bare name
// needs an extension that starts with a letter, so `1.2.3` and `e.g.` are not paths.
const PATH =
  /^(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?$/
const DIR_PATH = /^(?:~|\/)[\w.@+/-]*\/[\w.@+-]+(?::\d+)?$/
// `example.com` in backticks is a host, not a file next to the agent.
const HOST = /^[\w-]+\.(?:com|org|net|io|dev|ai|app|co|cn)$/i
/** Paths in a line of terminal text, for xterm's link provider. */
export const PATH_IN_TEXT =
  /(?<![\w./~-])(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)+[\w@+-][\w.@+-]*(?::\d+(?::\d+)?)?|(?<![\w./~-])[\w@+-][\w@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?::\d+)?)?(?![\w/])/g

/**
 * The file and line a reference names.
 * @param {string} raw
 * @returns {{ path: string; line: number | null }}
 */
export function splitLocation(raw) {
  const m = LOCATION.exec(raw.trim())
  if (!m) return { path: raw.trim(), line: null }
  return { path: m[1] ?? '', line: Number(m[2] ?? m[3]) || null }
}

/**
 * Inline code or a link target that names a file.
 * @param {string} text
 */
export function looksLikePath(text) {
  const s = text.trim()
  if (!s || s.length > 512 || /\s/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false
  if (HOST.test(s)) return false
  return PATH.test(s) || DIR_PATH.test(s)
}

// A link's scheme (`https:`, `mailto:`), unlike `notes.txt:12`, a file and its line.
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const NAME_AND_LINE = /^[^:/?#\s][^:?#]*\.[\w-]+:\d+(?::\d+)?$/

/**
 * The file a link or picture in a reply points at, decoded (`<my file.txt>`, `中文.png`, `file:///abs`), or null
 * for a web address, another scheme or an anchor. Unlike looksLikePath, which guesses from inline code, a link
 * says it is one: any name goes.
 * @param {string} href
 * @returns {string | null}
 */
export function localRef(href) {
  let s = href.trim()
  if (!s || s.length > 4096 || /^(?:#|\?|\/\/)/.test(s)) return null
  if (/^file:\/\//i.test(s)) s = s.replace(/^file:\/\/(?:localhost)?/i, '')
  else if (SCHEME.test(s) && !NAME_AND_LINE.test(s)) return null
  try {
    s = decodeURIComponent(s)
  } catch {}
  return s && !/[\0\n\r]/.test(s) ? s : null
}
