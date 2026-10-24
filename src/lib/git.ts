import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { Branch, Diff, DiffFile } from '../protocol.ts'
import { TtlCache } from './cache.ts'
import { exec } from './exec.ts'

const MAX_DIFF = 600_000
/** Untracked files larger than this are listed with a stub instead of their content. */
export const MAX_NEW_FILE = 256 * 1024
const MAX_UNTRACKED = 50

async function git(cwd: string, args: string[]): Promise<string | null> {
  const r = await exec(['git', '-C', cwd, ...args], { timeoutMs: 8000 })
  return r.code === 0 ? r.stdout : null
}

const branches = new TtlCache<string, Branch | null>(30_000)

/** The checked-out branch and how far it is from its upstream; null outside a repo. */
export function branchStatus(cwd: string): Promise<Branch | null> {
  return branches.getOrLoad(cwd, async () => {
    const name = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
    if (!name) return null
    const counts = await git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
    const [behind = 0, ahead = 0] = (counts ?? '').trim().split(/\s+/).map(Number)
    return { name, ahead: ahead || 0, behind: behind || 0 }
  })
}

/** Uncommitted changes against HEAD, plus untracked files. Null when `cwd` is not a work tree. */
export async function workingTreeDiff(cwd: string): Promise<Diff | null> {
  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') return null
  const hasHead = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])) !== null
  const base = hasHead ? ['HEAD'] : ['--cached']
  const [numstat, patch, untracked] = await Promise.all([
    git(cwd, ['diff', ...base, '--numstat', '-z']),
    // Raw (unquoted) non-ASCII paths in the headers, so they match the file list.
    git(cwd, ['-c', 'core.quotePath=false', 'diff', ...base, '--no-color', '--no-ext-diff', '-U3']),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  const files: DiffFile[] = parseNumstat(numstat ?? '')
  let diff = patch ?? ''
  for (const path of (untracked ?? '').split('\0').filter(Boolean).slice(0, MAX_UNTRACKED)) {
    const added = newFilePatch(path, readUntracked(join(cwd, path)))
    files.push(added.file)
    if (added.patch) diff += (diff && !diff.endsWith('\n') ? '\n' : '') + added.patch
  }
  return {
    files,
    diff: diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff truncated)` : diff,
    added: files.reduce((s, f) => s + f.added, 0),
    removed: files.reduce((s, f) => s + f.removed, 0),
  }
}

type Untracked = { kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'large'; size: number } | null

function readUntracked(path: string): Untracked {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    const buf = Buffer.alloc(Math.min(st.size, MAX_NEW_FILE + 1))
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, n)
    // git's own heuristic: a NUL in the first 8000 bytes means binary.
    if (head.subarray(0, 8000).includes(0)) return { kind: 'binary' }
    if (st.size > MAX_NEW_FILE) return { kind: 'large', size: st.size }
    return { kind: 'text', text: head.toString('utf8') }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * A git-style patch adding an untracked file, so the review shows new files like any other change. Binary
 * files get git's `Binary files … differ` line; files over MAX_NEW_FILE a stub without their content.
 */
export function newFilePatch(path: string, content: Untracked): { file: DiffFile; patch: string } {
  const file: DiffFile = { path, added: 0, removed: 0, untracked: true }
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n`
  if (!content) return { file, patch: '' }
  if (content.kind === 'binary') {
    file.binary = true
    return { file, patch: `${header}Binary files /dev/null and b/${path} differ\n` }
  }
  if (content.kind === 'large')
    return { file, patch: `${header}--- /dev/null\n+++ b/${path}\n(file too large to show)\n` }
  if (!content.text) return { file, patch: header }
  const lines = content.text.split('\n')
  const noNewline = lines.at(-1) !== ''
  if (!noNewline) lines.pop()
  file.added = lines.length
  const body = lines.map(l => `+${l}`).join('\n')
  return {
    file,
    patch: `${header}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n${noNewline ? '\\ No newline at end of file\n' : ''}`,
  }
}

// `--numstat -z`: "<add>\t<del>\t<path>\0", or for renames "<add>\t<del>\t\0<old>\0<new>\0".
export function parseNumstat(out: string): DiffFile[] {
  const parts = out.split('\0')
  const files: DiffFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i] ?? '')
    if (!m) continue
    let path = m[3] ?? ''
    if (!path) {
      i += 2
      path = parts[i] ?? ''
    }
    files.push({ path, added: Number(m[1]) || 0, removed: Number(m[2]) || 0 })
  }
  return files
}
