import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DirChoices } from '../protocol.ts'

export const MAX_RECENT_DIRS = 12
export const MAX_COMPLETIONS = 50

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function expandHome(path: string, home: string): string {
  return path.replace(/^~(?=$|\/)/, home)
}

/** Directories new sessions were started in, most recent first, kept in `<config dir>/dirs.json`. */
export class RecentDirs {
  private dirs: string[]

  constructor(readonly path: string) {
    this.dirs = this.load()
  }

  list(): string[] {
    return [...this.dirs]
  }

  record(dir: string): void {
    const clean = trimSlash(dir)
    if (this.dirs[0] === clean) return
    this.dirs = [clean, ...this.dirs.filter(d => d !== clean)].slice(0, MAX_RECENT_DIRS)
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ recent: this.dirs }), { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (err) {
      console.warn(`dirs: cannot save ${this.path}: ${(err as Error).message}`)
    }
  }

  private load(): string[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))?.recent
      return Array.isArray(raw)
        ? raw.filter((d): d is string => typeof d === 'string' && d.startsWith('/')).slice(0, MAX_RECENT_DIRS)
        : []
    } catch {
      return []
    }
  }
}

function trimSlash(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, '') || '/' : dir
}

/** The workspace's pane folders, then recent ones, then home: deduped, existing directories only. */
export function dirChoices(
  o: { paneCwds: string[]; recent: string[]; home: string },
  exists: (path: string) => boolean = isDir,
): DirChoices {
  const seen = new Set<string>()
  const recent: string[] = []
  for (const raw of [...o.paneCwds, ...o.recent, o.home]) {
    if (!raw?.startsWith('/')) continue
    const dir = trimSlash(raw)
    if (seen.has(dir)) continue
    seen.add(dir)
    if (exists(dir)) recent.push(dir)
  }
  return { recent, home: o.home }
}

/**
 * Subdirectories completing `partial`'s last segment, as full paths (`~` expanded). Hidden ones only
 * when the segment starts with `.`. A relative partial completes nothing: a session needs an absolute folder.
 */
export function completeDirs(partial: string, home: string, list: (dir: string) => string[] = listDirs): string[] {
  const path = expandHome(partial, home)
  if (!path.startsWith('/')) return []
  const cut = path.lastIndexOf('/')
  const parent = path.slice(0, cut + 1)
  const prefix = path.slice(cut + 1)
  const showHidden = prefix.startsWith('.')
  const lower = prefix.toLowerCase()
  const names = list(parent).filter(n => (showHidden || !n.startsWith('.')) && n !== '.' && n !== '..')
  const exact = names.filter(n => n.startsWith(prefix))
  const loose = names.filter(n => !n.startsWith(prefix) && n.toLowerCase().startsWith(lower))
  return [...exact.sort(), ...loose.sort()].slice(0, MAX_COMPLETIONS).map(n => parent + n)
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name))))
      .map(e => e.name)
  } catch {
    return []
  }
}
