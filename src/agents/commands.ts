import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { type Frontmatter, parseFrontmatter } from '../lib/frontmatter.ts'
import { isDir, listDir, readHead } from '../lib/fs.ts'
import type { Command } from '../protocol.ts'

const HEAD_BYTES = 16_384
const MAX_DEPTH = 3

export type Origin = Command['origin']

export function readMeta(path: string): Frontmatter {
  try {
    return parseFrontmatter(readHead(path, HEAD_BYTES).toString('utf8'))
  } catch {
    return { data: {}, body: '' }
  }
}

/** The first non-empty line of a Markdown body, without heading marks: the fallback description. */
export function firstLine(body: string): string {
  return (
    body
      .split('\n')
      .map(l => l.replace(/^#+\s*/, '').trim())
      .find(Boolean)
      ?.slice(0, 120) ?? ''
  )
}

export const description = (meta: Frontmatter) => (meta.data.description ?? '').trim() || firstLine(meta.body)

/** `<dir>/*.md`, `depth` levels down; `ns/foo.md` becomes `ns:foo`, as Claude Code names nested commands. */
export function markdownCommands(dir: string, origin: Origin, prefix = '', depth = MAX_DEPTH): Command[] {
  const out: Command[] = []
  for (const f of listDir(dir).sort()) {
    const path = join(dir, f)
    if (f.endsWith('.md'))
      out.push({ name: prefix + basename(f, '.md'), desc: description(readMeta(path)), type: 'command', origin })
    else if (depth > 0 && !f.startsWith('.') && isDir(path))
      out.push(...markdownCommands(path, origin, `${prefix}${f}:`, depth - 1))
  }
  return out
}

/** `<dir>/<name>/SKILL.md`, minus skills marked `user-invocable: false`. */
export function skillsIn(dir: string, origin: Origin, prefix = ''): Command[] {
  const out: Command[] = []
  for (const d of listDir(dir).sort()) {
    const path = join(dir, d, 'SKILL.md')
    if (!existsSync(path)) continue
    const meta = readMeta(path)
    if (meta.data['user-invocable'] === 'false') continue
    out.push({ name: prefix + (meta.data.name || d), desc: description(meta), type: 'skill', origin })
  }
  return out
}

/** Commands and skills under an agent config dir (`commands/`, `skills/`). */
export function scanConfigDir(dir: string, origin: Origin, prefix = ''): Command[] {
  return [...markdownCommands(join(dir, 'commands'), origin, prefix), ...skillsIn(join(dir, 'skills'), origin, prefix)]
}

export function builtins(table: readonly (readonly [string, string])[]): Command[] {
  return table.map(([name, desc]) => ({ name, desc, type: 'builtin', origin: 'builtin' }))
}

/** First occurrence of each name wins. */
export function dedupe(commands: Command[]): Command[] {
  const seen = new Set<string>()
  return commands.filter(c => !seen.has(c.name) && !!seen.add(c.name))
}
