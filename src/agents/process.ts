import { readFileSync } from 'node:fs'
import { herdr } from '../herdr.ts'
import { TtlCache } from '../lib/cache.ts'
import { exec } from '../lib/exec.ts'

/** What a Codex pane's foreground processes reveal about which rollout it shows. */
export interface PaneProcess {
  /** Session id from `codex resume <id>`. */
  resumeId: string | null
  /** Session id from `codex fork <id>`: the parent, which the fork must not be mistaken for. */
  forkParentId: string | null
  /** When the pane's Codex process started (ms since epoch), 0 when unknown. */
  startedAt: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const processes = new TtlCache<string, PaneProcess>(5_000, 500)

export async function paneProcess(pane: string): Promise<PaneProcess> {
  return processes.getOrLoad(pane, async () => {
    const hints: PaneProcess = { resumeId: null, forkParentId: null, startedAt: 0 }
    let info: Awaited<ReturnType<typeof herdr.processInfo>>
    try {
      info = await herdr.processInfo(pane)
    } catch {
      return hints
    }
    for (const p of info.foreground_processes ?? []) {
      const argv = p.argv ?? []
      const { resumeId, forkParentId } = argvHints(argv)
      hints.resumeId ??= resumeId
      hints.forkParentId ??= forkParentId
      // The npm `codex` is a node wrapper; the native binary it spawns is the one named codex.
      if (p.name === 'codex' || /codex$/.test(argv[0] ?? ''))
        hints.startedAt = Math.max(hints.startedAt, await processStartedAt(p.pid))
    }
    return hints
  })
}

const claudePids = new TtlCache<string, number[]>(5_000, 500)

/** The pane's foreground Claude Code processes (the npm `claude`, or the native binary). */
export function paneClaudePids(pane: string): Promise<number[]> {
  return claudePids.getOrLoad(pane, async () => {
    try {
      const info = await herdr.processInfo(pane)
      return (info.foreground_processes ?? [])
        .filter(p => p.name === 'claude' || /(^|\/)claude$/.test(p.argv?.[0] ?? ''))
        .map(p => p.pid)
    } catch {
      return []
    }
  })
}

/** Session ids in a Codex argv: `resume <id>`, `fork <id>`. */
export function argvHints(argv: readonly string[]): Pick<PaneProcess, 'resumeId' | 'forkParentId'> {
  let resumeId: string | null = null
  let forkParentId: string | null = null
  argv.forEach((arg, i) => {
    const next = argv[i + 1] ?? ''
    if (!UUID.test(next)) return
    if (arg === 'resume') resumeId ??= next
    else if (arg === 'fork') forkParentId ??= next
  })
  return { resumeId, forkParentId }
}

// /proc reports times in USER_HZ, which is 100 on every mainstream architecture.
const USER_HZ = 100
let bootMs: number | null | undefined

async function processStartedAt(pid: number): Promise<number> {
  if (process.platform === 'linux') {
    if (bootMs === undefined) bootMs = readBootMs()
    if (bootMs != null) {
      try {
        const ticks = procStatStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'))
        if (ticks != null) return bootMs + (ticks / USER_HZ) * 1000
      } catch {}
    }
  }
  const r = await exec(['ps', '-o', 'etime=', '-p', String(pid)], { timeoutMs: 3000 }).catch(() => null)
  const elapsed = r?.code === 0 ? parseElapsed(r.stdout) : null
  return elapsed == null ? 0 : Date.now() - elapsed * 1000
}

/** Boot time from /proc/stat's `btime`, null when unavailable. */
function readBootMs(): number | null {
  try {
    const btime = Number(/^btime (\d+)/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1])
    return btime ? btime * 1000 : null
  } catch {
    return null
  }
}

/** Field 22 (starttime, in clock ticks since boot) of /proc/<pid>/stat. The comm field may hold spaces and ')'. */
export function procStatStartTicks(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const ticks = Number(fields[19])
  return Number.isFinite(ticks) && fields.length > 19 ? ticks : null
}

/** `ps -o etime=` output, `[[dd-]hh:]mm:ss`, in seconds. */
export function parseElapsed(etime: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(etime)
  if (!m) return null
  const [, d = '0', h = '0', min = '0', s = '0'] = m
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)
}
