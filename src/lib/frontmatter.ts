export interface Frontmatter {
  /** Top-level scalar keys. Nested mappings and lists are skipped. */
  data: Record<string, string>
  body: string
}

const KEY = /^([A-Za-z0-9_][\w.-]*)\s*:(?:\s+(.*))?$/
const BLOCK = /^([|>])[+-]?\d*[+-]?\s*(?:#.*)?$/

/**
 * Parses the YAML frontmatter of a Markdown file, enough for command and skill metadata:
 * plain, quoted, folded (`>`) and literal (`|`) scalars, and multi-line plain scalars. CRLF-safe.
 * Block chomping indicators are accepted and ignored: a block value never ends in a newline.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  if (lines[0]?.trimEnd() !== '---') return { data: {}, body: src }
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l))
  if (close < 0) return { data: {}, body: src }

  const data: Record<string, string> = {}
  const head = lines.slice(1, close)
  let i = 0
  while (i < head.length) {
    const m = KEY.exec(head[i] ?? '')
    i++
    if (!m) continue
    const key = m[1] as string
    const value = (m[2] ?? '').trim()
    const cont: string[] = []
    while (i < head.length && (/^\s/.test(head[i] ?? '') || head[i] === '')) cont.push(head[i++] as string)
    while (cont.length && !cont[cont.length - 1]?.trim()) cont.pop()

    const block = BLOCK.exec(value)
    if (block) {
      data[key] = blockScalar(cont, block[1] === '>')
    } else if (value) {
      data[key] = cont.length && !isQuoted(value) ? [value, ...cont.map(l => l.trim())].join(' ') : scalar(value)
    } else if (cont.length && !/^\s*(-\s|[\w.-]+\s*:(\s|$))/.test(cont[0] ?? '')) {
      data[key] = foldPlain(cont)
    }
  }
  return { data, body: lines.slice(close + 1).join('\n') }
}

function isQuoted(v: string): boolean {
  return v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))
}

// YAML escapes, a different set from TOML's (codex/config.ts): `\/` is valid here.
function scalar(v: string): string {
  if (!isQuoted(v)) return v.replace(/\s+#.*$/, '')
  const inner = v.slice(1, -1)
  if (v[0] === "'") return inner.replace(/''/g, "'")
  return inner.replace(/\\(["\\/nt])/g, (_, c: string) => ({ n: '\n', t: '\t' })[c as 'n'] ?? c)
}

function blockScalar(lines: string[], folded: boolean): string {
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => /^\s*/.exec(l)?.[0].length ?? 0))
  const body = lines.map(l => l.slice(Number.isFinite(indent) ? indent : 0))
  return folded ? foldLines(body) : body.join('\n')
}

// Folding: single newlines become spaces, blank lines stay as newlines, more-indented lines keep theirs.
function foldLines(lines: string[]): string {
  let out = ''
  let prev: 'text' | 'blank' | 'indented' | null = null
  for (const l of lines) {
    const kind = !l.trim() ? 'blank' : /^\s/.test(l) ? 'indented' : 'text'
    if (prev === null) out = l
    else if (kind === 'blank') out += '\n'
    else if (kind === 'text' && prev === 'text') out += ` ${l}`
    else out += prev === 'blank' ? l : `\n${l}`
    prev = kind
  }
  return out
}

function foldPlain(lines: string[]): string {
  return lines
    .map(l => l.trim())
    .join(' ')
    .replace(/\s{2,}/g, ' ')
}
