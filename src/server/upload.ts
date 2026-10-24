import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { UserError } from './http.ts'

export const MAX_UPLOAD_BYTES = 25 << 20
const KEEP_MS = 7 * 24 * 3600_000
const PRUNE_EVERY_MS = 3600_000
// Keyed by upload dir, of which a server has one.
const prunedAt = new Map<string, number>()

/** A file name safe on every filesystem and in a shell prompt: letters/digits of any script, `.`, `_`, `-`. */
export function sanitizeName(raw: string | null): string {
  const name = basename(raw || 'paste.png')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '')
    .slice(-80)
  return name || 'upload'
}

/** Create the upload dir private to this user, refusing one that is a symlink or owned by someone else. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`upload dir ${dir} is not a directory`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    throw new Error(`upload dir ${dir} is owned by another user`)
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
}

/** Delete uploads older than a week; they were pasted into an agent prompt long ago. */
export function pruneUploads(dir: string, now = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      const st = lstatSync(path)
      if (st.isFile() && now - st.mtimeMs > KEEP_MS) unlinkSync(path)
    } catch {}
  }
}

/** Store a pasted or dropped file and return its absolute path, which the UI types into the agent. */
export async function saveUpload(req: Request, dir: string, rawName: string | null): Promise<{ path: string }> {
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > MAX_UPLOAD_BYTES) throw tooLarge()
  const body = new Uint8Array(await req.arrayBuffer())
  if (body.byteLength > MAX_UPLOAD_BYTES) throw tooLarge()
  ensurePrivateDir(dir)
  // A long-running server would otherwise only prune at startup.
  const now = Date.now()
  if (now - (prunedAt.get(dir) ?? 0) > PRUNE_EVERY_MS) {
    prunedAt.set(dir, now)
    pruneUploads(dir, now)
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const path = join(dir, `${stamp}-${randomBytes(3).toString('hex')}-${sanitizeName(rawName)}`)
  writeFileSync(path, body, { mode: 0o600, flag: 'wx' })
  return { path }
}

function tooLarge(): UserError {
  return new UserError('payload_too_large', `Uploads are limited to ${MAX_UPLOAD_BYTES >> 20} MB`, 413)
}
