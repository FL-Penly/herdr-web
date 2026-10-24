import { statSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { UserError } from './http.ts'

/** Past this, a file is not served: the viewer is for what an agent made, not for disk images. */
export const MAX_FILE_BYTES = 64 << 20

/**
 * A path as an agent wrote it, as a file on this machine: absolute, `~/…`, or relative to the pane's folder.
 * Anything the user can read is fair game: whoever has the token can already run commands in the panes.
 */
export function resolveFile(raw: string, cwd: string, home: string): string {
  const path = raw.trim()
  if (!path || path.length > 4096 || path.includes('\0')) throw new UserError('bad_request', 'The path is invalid')
  if (path === '~' || path.startsWith('~/')) return normalize(join(home, path.slice(1)))
  return normalize(isAbsolute(path) ? path : join(cwd, path))
}

/** The file's bytes for the viewer. It is never run: the response may not load or execute anything. */
export function fileResponse(path: string): Response {
  let size: number
  try {
    const st = statSync(path)
    if (!st.isFile()) throw new UserError('not_a_file', `${path} is not a file`)
    size = st.size
  } catch (err) {
    if (err instanceof UserError) throw err
    throw new UserError('file_not_found', `No file ${path}`, 404)
  }
  if (size > MAX_FILE_BYTES) throw new UserError('file_too_large', `${path} is over ${MAX_FILE_BYTES >> 20} MB`, 413)
  const file = Bun.file(path)
  return new Response(file as unknown as Blob, {
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'x-file-path': encodeURIComponent(path),
    },
  })
}
