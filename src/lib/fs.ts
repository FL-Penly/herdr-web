import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { TtlCache } from './cache.ts'

export function readJson<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The first `bytes` of a file (or less), without reading the rest. */
export function readHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0))
  } finally {
    closeSync(fd)
  }
}

/** The first line of a file, read in chunks up to `max` bytes. */
export function readFirstLine(path: string, max = 1 << 20): string {
  let size = 8192
  for (;;) {
    const head = readHead(path, size)
    const nl = head.indexOf(10)
    if (nl >= 0) return head.subarray(0, nl).toString('utf8')
    if (head.length < size || size >= max) return head.toString('utf8')
    size *= 4
  }
}

const parsed = new TtlCache<string, { mtimeMs: number; size: number; parse: unknown; value: unknown }>(
  Number.POSITIVE_INFINITY,
  200,
)

/** `parse(text of path)`, re-run only when the file's mtime or size changes; null when unreadable or unparseable. */
export function readCached<T>(path: string, parse: (text: string) => T): T | null {
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(path)
  } catch {
    parsed.delete(path)
    return null
  }
  const hit = parsed.get(path)
  if (hit && hit.parse === parse && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value as T | null
  const text = readText(path)
  let value: T | null = null
  try {
    value = text == null ? null : parse(text)
  } catch {}
  return parsed.set(path, { mtimeMs: st.mtimeMs, size: st.size, parse, value }).value as T | null
}

export const readJsonCached = <T = unknown>(path: string): T | null => readCached<T>(path, JSON.parse)

export function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The file's mtime in ms, 0 when it is missing. */
export function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}
