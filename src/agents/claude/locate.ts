import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'
import { config } from '../../config.ts'
import { TtlCache } from '../../lib/cache.ts'

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const found = new TtlCache<string, string>(Number.POSITIVE_INFINITY, 2_000)
// Claude Code writes <session>.jsonl only after the first prompt, so a miss is retried after a few seconds.
const misses = new TtlCache<string, true>(5_000, 1_000)

const JOB_ID = /^[0-9a-f]{8}$/
// What `/resume` prints when it opens a session that runs in the background, in the transcript of the session
// it was typed in.
const OPENED_JOB =
  /^<local-command-stdout>Opening ".*", running in the background \(([0-9a-f]{8})\)<\/local-command-stdout>$/s
const TAIL_BYTES = 64 << 10

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * The session a running Claude Code process shows, from the registry it keeps for itself:
 * `<claude dir>/sessions/<pid>.json`. Its `sessionId` follows `/resume` and `/clear` inside the TUI. A process
 * can show a background job instead, whose session is in `<claude dir>/jobs/<id>/state.json`: one its own
 * session's last act was to open (`/resume` of a background session; the registry keeps the process's own
 * session then), or else the job it sent its conversation to (`parkedJobId`). Null when no registry names one.
 */
export function claudeProcessSession(pid: number, dirs: readonly string[] = config.claudeDirs): string | null {
  for (const dir of dirs) {
    const entry = readJson(join(dir, 'sessions', `${pid}.json`))
    if (!entry || entry.pid !== pid) continue
    const own = typeof entry.sessionId === 'string' && SESSION_ID.test(entry.sessionId) ? entry.sessionId : null
    const opened = own ? openedJob(own, dirs) : null
    for (const job of [opened, entry.parkedJobId]) {
      if (typeof job !== 'string' || !JOB_ID.test(job)) continue
      const session = readJson(join(dir, 'jobs', job, 'state.json'))?.sessionId
      if (typeof session === 'string' && SESSION_ID.test(session)) return session
    }
    if (own) return own
  }
  return null
}

/** The background job `session` opened last, if nothing was said in it since. */
function openedJob(session: string, dirs: readonly string[]): string | null {
  const path = findClaudeTranscript(session, dirs)
  if (!path) return null
  for (const line of tail(path).split('\n').reverse()) {
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type === 'user' || row.type === 'assistant') return null
    if (row.type === 'system' && typeof row.content === 'string') {
      const job = OPENED_JOB.exec(row.content)?.[1]
      if (job) return job
    }
  }
  return null
}

/** The last bytes of a file; a partial first line just fails to parse. */
function tail(path: string): string {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** `<claude dir>/projects/<project>/<session>.jsonl`, searched in every configured Claude dir. */
export function findClaudeTranscript(session: string, dirs: readonly string[] = config.claudeDirs): string | null {
  if (!SESSION_ID.test(session)) return null
  const hit = found.get(session)
  if (hit && existsSync(hit)) return hit
  found.delete(session)
  if (misses.get(session)) return null
  for (const dir of dirs) {
    if (!existsSync(join(dir, 'projects'))) continue
    for (const path of new Glob(`projects/*/${session}.jsonl`).scanSync({ cwd: dir, absolute: true })) {
      return found.set(session, path)
    }
  }
  misses.set(session, true)
  return null
}
