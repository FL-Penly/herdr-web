// @ts-check

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }
const utf8 = new TextEncoder()
const HEADER_RE = /^(index |new file|deleted file|similarity|dissimilarity|rename |copy |old mode|new mode)/

/**
 * Git quotes paths with special or (with core.quotePath) non-ASCII characters: `"b/\303\251.txt"` → `b/é.txt`.
 * @param {string} path
 */
function unquotePath(path) {
  if (!path.startsWith('"')) return path
  /** @type {number[]} */
  const bytes = []
  const body = path.slice(1, -1)
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') bytes.push(...utf8.encode(body[i]))
    else if (/[0-7]/.test(body[i + 1])) {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      const c = body[++i]
      bytes.push(C_ESCAPES[/** @type {keyof typeof C_ESCAPES} */ (c)] ?? c.charCodeAt(0))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/**
 * The path after `a/` or `b/`, unquoted, without the tab git appends to `---`/`+++` names that contain spaces.
 * @param {string} name
 */
const stripPrefix = name => unquotePath(name.replace(/\t$/, '')).replace(/^[ab]\//, '')

/**
 * Splits `git diff` output per file, dropping the header lines the review panel does not show.
 * The path is the new one (the old one for a deletion), as in the file list.
 * @param {string} text
 * @returns {{ path: string; lines: string[] }[]}
 */
export function splitDiff(text) {
  /** @type {{ path: string; lines: string[] }[]} */
  const files = []
  /** @type {{ path: string; lines: string[] } | null} */
  let current = null
  let inHeader = false
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      // `a/x b/x` or `"a/x" "b/x"`; only binary, mode-only and pure-rename entries lack `---`/`+++` lines.
      const rest = line.slice('diff --git '.length)
      const at = rest.endsWith('"') ? rest.lastIndexOf(' "') : rest.lastIndexOf(' b/')
      current = { path: stripPrefix(rest.slice(at + 1)), lines: [] }
      files.push(current)
      inHeader = true
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) inHeader = false
    if (inHeader) {
      const name = /^(?:---|\+\+\+) (.*)$/.exec(line)?.[1]
      if (name && name !== '/dev/null') current.path = stripPrefix(name)
      if (name || HEADER_RE.test(line)) continue
    }
    current.lines.push(line)
  }
  return files
}

/**
 * @typedef {{ type: 'hunk' | 'note'; text: string } | { type: 'add' | 'del' | 'ctx'; text: string; line: number | null }} DiffRow
 */

/**
 * Numbers a file's diff lines by their position in the new file (deleted lines get none). A line that is not
 * part of a hunk (`Binary files … differ`, the server's `(file too large to show)`) is a `note`.
 * @param {string[]} lines
 * @returns {DiffRow[]}
 */
export function diffRows(lines) {
  /** @type {DiffRow[]} */
  const rows = []
  let n = 0
  for (const line of lines) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
    if (hunk) {
      n = Number(hunk[1])
      rows.push({ type: 'hunk', text: line })
      continue
    }
    if (line.startsWith('\\') || line === '') continue
    if (!/^[ +-]/.test(line)) {
      rows.push({ type: 'note', text: line })
      continue
    }
    const type = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
    rows.push({ type, text: line, line: type === 'del' ? null : n })
    if (type !== 'del') n++
  }
  return rows
}

/**
 * Line class for a unified diff shown inside a tool step (no hunk numbering).
 * @param {string} line
 * @returns {'add' | 'del' | ''}
 */
export function diffLineClass(line) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'del'
  return ''
}

/**
 * Tool steps report paths relative to the agent while git reports them relative to the repo root.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
export function samePath(a, b) {
  return !!a && !!b && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`))
}

/**
 * The patch of the file picked in the review list: the same path, else the only one `samePath` matches.
 * Null when the diff has none for it (a file git lists but does not diff), never another file's patch.
 * @template {{ path: string }} F
 * @param {F[]} files
 * @param {string} path
 * @returns {F | null}
 */
export function patchFor(files, path) {
  const exact = files.find(f => f.path === path)
  if (exact) return exact
  const loose = files.filter(f => samePath(f.path, path))
  return loose.length === 1 ? loose[0] : null
}

/**
 * Identifies a diff by its content, so a repaint is skipped only when nothing on disk changed. An edit that
 * swaps `'ok'` for `'up'` keeps the file list, the counts and the patch length, so all three plus a 53-bit
 * hash of the patch text (cyrb53) go in.
 * @param {{ files: unknown[]; diff: string }} diff
 */
export function diffSignature(diff) {
  const text = String(diff.diff ?? '')
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return `${JSON.stringify(diff.files)}:${text.length}:${hash.toString(36)}`
}
