import { join } from 'node:path'
import { config } from '../../config.ts'
import { readCached } from '../../lib/fs.ts'

export interface CodexConfig {
  model?: string
  effort?: string
  profile?: string
}

export const codexSessionsRoot = () => join(config.codexHome, 'sessions')

/** `model` and `model_reasoning_effort` from config.toml: top level, overridden by the active `[profiles.<name>]`. */
export function readCodexConfig(path = join(config.codexHome, 'config.toml')): CodexConfig {
  return readCached(path, codexConfigFrom) ?? {}
}

export function codexConfigFrom(toml: string): CodexConfig {
  const tables = parseTomlStrings(toml)
  const top = tables.get('') ?? {}
  const profile = top.profile
  const active = profile ? (tables.get(`profiles.${profile}`) ?? {}) : {}
  const pick = (key: string) => active[key] ?? top[key]
  return {
    ...(pick('model') ? { model: pick('model') } : {}),
    ...(pick('model_reasoning_effort') ? { effort: pick('model_reasoning_effort') } : {}),
    ...(profile ? { profile } : {}),
  }
}

/**
 * The string-valued keys of a TOML document, per table (`''` is the top level). A deliberately small
 * subset: `[a.b]` / `[a."b c"]` headers and `key = "basic"` / `key = 'literal'` values. Everything else
 * (arrays, inline tables, numbers, multi-line strings) is skipped without confusing the table tracking.
 */
export function parseTomlStrings(toml: string): Map<string, Record<string, string>> {
  const tables = new Map<string, Record<string, string>>([['', {}]])
  let table = ''
  let inMultiline: string | null = null
  for (const raw of toml.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (inMultiline) {
      if (line.includes(inMultiline)) inMultiline = null
      continue
    }
    if (!line || line.startsWith('#')) continue
    const header = /^\[\s*([^[\]]+?)\s*\](\s*#.*)?$/.exec(line)
    if (header) {
      table = (header[1] ?? '')
        .split('.')
        .map(s => s.trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2'))
        .join('.')
      if (!tables.has(table)) tables.set(table, {})
      continue
    }
    if (line.startsWith('[[')) {
      table = '\0array'
      continue
    }
    const kv = /^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = (kv[1] ?? '').replace(/^"(.*)"$/, '$1')
    const value = kv[2] ?? ''
    const multi = /^("""|''')/.exec(value)?.[1]
    if (multi) {
      if (!value.slice(3).includes(multi)) inMultiline = multi
      continue
    }
    const str = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value)
    if (!str) continue
    const target = tables.get(table)
    if (target) target[key] = str[2] ?? unescapeBasic(str[1] ?? '')
  }
  return tables
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(["\\nt])/g, (_, c: string) => ({ n: '\n', t: '\t' })[c as 'n'] ?? c)
}
