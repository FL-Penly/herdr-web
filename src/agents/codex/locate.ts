import { basename, join, resolve } from 'node:path'
import { TtlCache } from '../../lib/cache.ts'
import { isFile, listDir, mtimeOf, readFirstLine, readHead } from '../../lib/fs.ts'
import { sameText } from '../../tui/screen.ts'
import { codexSessionsRoot } from './config.ts'

export interface RolloutMeta {
  path: string
  id: string | null
  cwd: string
  /** Timestamp of the session_meta line (ms). */
  created: number
  originator: string
}

export interface RolloutCandidate extends RolloutMeta {
  mtime: number
}

export interface PickOptions {
  cwd: string
  /** Start of the pane's Codex process (ms); 0 when unknown. */
  startedAt: number
  forkParentId: string | null
  claimed: ReadonlySet<string>
  /**
   * The rollout the pane shows now. `explicit`: it was named (`codex resume <id>`) or proven by what the
   * pane echoed, so only that kind of evidence moves the pane, never a newer file in the folder.
   */
  current: { path: string; created: number; explicit?: boolean } | null
  /** Other live Codex panes in the same cwd: then a newer rollout cannot be attributed to /new. */
  siblings: number
  /**
   * When other Codex panes in the same cwd were alive, closed ones included: a rollout created meanwhile may be
   * theirs, so it is never taken for this pane's /new.
   */
  othersAlive?: readonly Lifetime[]
  now?: number
}

export interface Lifetime {
  from: number
  to: number
}

const HOUR = 3600_000
const START_SLACK_MS = 5_000
// Without /proc the start time comes from `ps -o etime` (whole seconds) and moves by up to a second per read.
const START_JITTER_MS = 2_000
const CLAIM_TTL_MS = 6 * HOUR
const SIBLING_WINDOW_MS = 60_000
/** How long the live pane list from the last state tick counts; without a fresh one, recent lookups stand in. */
const LIVE_TTL_MS = 10_000
/**
 * A rollout this young may belong to a pane herdr does not report yet: `codex fork` (the quick-fork plugin)
 * writes its rollout as it starts, and the original pane must not take it for its own `/new`.
 */
const NEW_SETTLE_MS = 10_000
const MAX_META_READS = 160
/** How often all rollouts are listed by mtime to notice one an in-TUI `/resume` moved to. */
const TOUCHED_SCAN_MS = 3_000
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/**
 * `rollout-<time>-<session>.jsonl`, or `rollout-<time>-<session>_<segment>.jsonl`: since Codex 0.164 a resumed
 * session goes on in a new file, a segment whose history_base is the segment before it.
 */
const ROLLOUT_ID = new RegExp(`(${UUID})(?:_${UUID})?\\.jsonl$`, 'i')

/**
 * Which rollout a Codex pane shows. A fresh pane gets the earliest rollout in its cwd created after its
 * process started (its own first thread; later ones may belong to panes started after it). A pane that
 * already shows one moves to a newer rollout only when nothing else could own it: that is Codex `/new`
 * or `/clear`, which start a new rollout in the same process. A pane whose rollout is explicit never does:
 * another Codex outside herdr may have written the newer file.
 */
export function pickRollout(candidates: readonly RolloutCandidate[], o: PickOptions): string | null {
  const eligible = candidates.filter(
    c =>
      c.cwd === o.cwd &&
      isInteractive(c.originator) &&
      !o.claimed.has(c.path) &&
      !(o.forkParentId && c.id === o.forkParentId) &&
      (!o.startedAt || c.created >= o.startedAt - START_SLACK_MS),
  )
  if (o.current) {
    const current = o.current
    if (o.siblings > 0 || current.explicit) return current.path
    const settled = (o.now ?? Date.now()) - NEW_SETTLE_MS
    const contested = (c: RolloutCandidate) =>
      (o.othersAlive ?? []).some(l => c.created >= l.from - START_SLACK_MS && c.created <= l.to + LIVE_TTL_MS)
    const newer = eligible.filter(
      c => c.path !== current.path && c.created > current.created && c.created <= settled && !contested(c),
    )
    return newer.sort((a, b) => b.created - a.created)[0]?.path ?? current.path
  }
  if (o.startedAt) return [...eligible].sort((a, b) => a.created - b.created)[0]?.path ?? null
  return [...eligible].sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null
}

/** `codex exec` runs headless: its rollouts are never a pane's. */
function isInteractive(originator: string): boolean {
  return originator !== 'codex_exec'
}

/** The session id in a rollout file name (`rollout-<date>-<uuid>.jsonl`, or `…-<uuid>_<segment>.jsonl`). */
export function codexSessionId(rolloutPath: string): string | null {
  return ROLLOUT_ID.exec(rolloutPath)?.[1] ?? null
}

/** Whether rollout `a` was started before `b`: their names begin with the time they were created. */
const startedBefore = (a: string, b: string) => basename(a) < basename(b)

const metas = new TtlCache<string, RolloutMeta>(24 * HOUR, 5_000)

/** session_meta of a rollout, from its first 8 KiB (the full first line can be large). Immutable, so cached. */
function readRolloutMeta(path: string): RolloutMeta | null {
  const hit = metas.get(path)
  if (hit) return hit
  let head: string
  try {
    head = readHead(path, 8192).toString('utf8')
  } catch {
    return null
  }
  const meta = rolloutMetaFrom(path, head)
  if (meta) metas.set(path, meta)
  return meta
}

export function rolloutMetaFrom(path: string, head: string): RolloutMeta | null {
  const cwd = /"cwd":\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
  if (cwd == null) return null
  let decoded: string
  try {
    decoded = JSON.parse(`"${cwd}"`)
  } catch {
    return null
  }
  return {
    path,
    id: codexSessionId(path),
    cwd: decoded,
    created: Date.parse(/"timestamp":\s*"([^"]+)"/.exec(head)?.[1] ?? '') || 0,
    originator: /"originator":\s*"([^"]*)"/.exec(head)?.[1] ?? '',
  }
}

/**
 * Rollout files, newest day directory first. Rollouts are filed under their creation date, so with
 * `since` the walk stops at day directories older than that (with a day of slack for time zones).
 */
export function listRollouts(root: string, since = 0): string[] {
  const floor = since ? dayKey(new Date(since - 24 * HOUR)) : ''
  const files: string[] = []
  for (const y of listDir(root).sort().reverse()) {
    if (!/^\d{4}$/.test(y)) continue
    for (const m of listDir(join(root, y)).sort().reverse()) {
      if (!/^\d{2}$/.test(m)) continue
      for (const d of listDir(join(root, y, m))
        .sort()
        .reverse()) {
        if (!/^\d{2}$/.test(d)) continue
        if (floor && `${y}${m}${d}` < floor) return files
        for (const f of listDir(join(root, y, m, d))) if (f.endsWith('.jsonl')) files.push(join(root, y, m, d, f))
      }
    }
  }
  return files
}

function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

function candidates(root: string, since: number): RolloutCandidate[] {
  const files = listRollouts(root, since)
    .map(path => ({ path, mtime: mtimeOf(path) }))
    .sort((a, b) => b.mtime - a.mtime)
  const out: RolloutCandidate[] = []
  for (const f of files.slice(0, MAX_META_READS)) {
    const meta = readRolloutMeta(f.path)
    if (meta) out.push({ ...meta, mtime: f.mtime })
  }
  return out
}

interface PaneRollout {
  path: string
  created: number
  explicit: boolean
  cwd: string
  startedAt: number
  at: number
}

// Pruned by age on every locate call (lifetimes on every state tick).
const panes = new Map<string, PaneRollout>()
const seen = new Map<string, { cwd: string; at: number }>()
let live: { panes: Map<string, string>; at: number } = { panes: new Map(), at: 0 }
const lifetimes = new Map<string, Lifetime & { cwd: string }>()

/**
 * Every Codex pane herdr reports, with its cwd, from each state tick. A pane that is working is not looked
 * up, so recent lookups alone would miss it as the owner of a newer rollout; a closed pane stops claiming
 * its rollout (another pane may `/resume` it), but what it wrote while alive is never another pane's `/new`.
 */
export function setLiveCodexPanes(list: readonly { pane: string; cwd: string }[], now = Date.now()): void {
  live = { panes: new Map(list.map(p => [p.pane, p.cwd])), at: now }
  for (const pane of panes.keys()) if (!live.panes.has(pane)) panes.delete(pane)
  for (const { pane, cwd } of list) {
    const life = lifetimes.get(pane)
    if (life?.cwd === cwd) life.to = now
    else lifetimes.set(pane, { cwd, from: now, to: now })
  }
  for (const [pane, l] of lifetimes) if (now - l.to > CLAIM_TTL_MS) lifetimes.delete(pane)
}

function othersAliveIn(pane: string, cwd: string): Lifetime[] {
  return [...lifetimes].filter(([p, l]) => p !== pane && l.cwd === cwd).map(([, l]) => l)
}

function siblingsOf(pane: string, cwd: string, now: number): number {
  const others = new Set<string>()
  if (now - live.at < LIVE_TTL_MS) for (const [p, c] of live.panes) if (p !== pane && c === cwd) others.add(p)
  for (const [p, s] of seen) if (p !== pane && s.cwd === cwd) others.add(p)
  return others.size
}

/** Whether another pane shows `path`: a pane is never moved onto a rollout that someone else owns. */
export function claimedElsewhere(path: string, pane: string): boolean {
  for (const [p, r] of panes) if (p !== pane && r.path === path) return true
  return false
}

export interface LocateInput {
  pane: string
  cwd: string
  resumeId: string | null
  forkParentId: string | null
  startedAt: number
}

/** The rollout a Codex pane is showing. Sticky per pane and process; follows `/new`; never another pane's. */
export function locateCodexRollout(o: LocateInput, root = codexSessionsRoot(), now = Date.now()): string | null {
  for (const [pane, p] of panes) if (now - p.at > CLAIM_TTL_MS) panes.delete(pane)
  for (const [pane, s] of seen) if (now - s.at > SIBLING_WINDOW_MS) seen.delete(pane)
  seen.set(o.pane, { cwd: o.cwd, at: now })
  let prev = panes.get(o.pane)
  const restarted = prev && Math.abs(prev.startedAt - o.startedAt) > START_JITTER_MS
  if (prev && (restarted || prev.cwd !== o.cwd || !isFile(prev.path))) prev = undefined
  let current = prev ? { path: prev.path, created: prev.created, explicit: prev.explicit } : null
  if (!current && o.resumeId) {
    const path = rolloutById(o.resumeId, root)
    const meta = path ? readRolloutMeta(path) : null
    if (path) current = { path, created: meta?.created ?? 0, explicit: true }
  }
  const claimed = new Set([...panes].filter(([pane]) => pane !== o.pane).map(([, p]) => p.path))
  // The session went on in a new segment (it was resumed): same session, so as good evidence as the old one.
  const next = current ? laterSegment(current.path, claimed, root, now) : null
  if (current && next) current = { ...current, path: next, created: readRolloutMeta(next)?.created ?? 0 }
  const siblings = siblingsOf(o.pane, o.cwd, now)
  const since = current ? Math.max(o.startedAt, current.created) : o.startedAt
  const othersAlive = othersAliveIn(o.pane, o.cwd)
  const path = pickRollout(candidates(root, since), { ...o, claimed, current, siblings, othersAlive, now })
  if (!path) {
    panes.delete(o.pane)
    return null
  }
  const same = path === current?.path
  const created = same ? (current?.created ?? 0) : (readRolloutMeta(path)?.created ?? 0)
  panes.set(o.pane, {
    path,
    created,
    explicit: same && !!current?.explicit,
    cwd: o.cwd,
    startedAt: o.startedAt,
    at: now,
  })
  return path
}

/** The newest segment of `path`'s session started after it that no other pane shows, from recently written files. */
function laterSegment(path: string, claimed: ReadonlySet<string>, root: string, now: number): string | null {
  const id = codexSessionId(path)
  if (!id) return null
  const later = touchedRollouts(mtimeOf(path), root, now).filter(
    p => codexSessionId(p) === id && startedBefore(path, p) && !claimed.has(p),
  )
  return later.sort((a, b) => (startedBefore(a, b) ? 1 : -1))[0] ?? null
}

// One entry per sessions root: CODEX_HOME plus the root a forked rollout lives in, so a handful at most.
const indexes = new Map<string, { byId: Map<string, string[]>; paths: Set<string>; at: number }>()
const REINDEX_MS = 5_000

/** The newest of `paths` started before `before` (any, without it) that still exists. */
function newestSegment(paths: readonly string[] | undefined, before: string | undefined): string | null {
  let best: string | null = null
  for (const p of paths ?? []) {
    if (before && !startedBefore(p, before)) continue
    if ((!best || startedBefore(best, p)) && isFile(p)) best = p
  }
  return best
}

/**
 * The rollout of a Codex session id: its newest segment, or with `before`, the newest one started before that
 * file (the one a segment or a fork continues). The id → paths index is rebuilt at most every few seconds on a
 * miss, and whenever it predates `before`: a segment written since could be the one wanted.
 */
export function rolloutById(id: string, root = codexSessionsRoot(), before?: string): string | null {
  let index = indexes.get(root)
  const stale = !!before && before.startsWith(`${root}/`) && !index?.paths.has(before)
  if (!stale) {
    const hit = newestSegment(index?.byId.get(id), before)
    if (hit) return hit
    if (index && Date.now() - index.at < REINDEX_MS) return null
  }
  index = { byId: new Map(), paths: new Set(), at: Date.now() }
  indexes.set(root, index)
  for (const path of listRollouts(root)) {
    index.paths.add(path)
    const sid = codexSessionId(path)
    if (!sid) continue
    const list = index.byId.get(sid)
    if (list) list.push(path)
    else index.byId.set(sid, [path])
  }
  return newestSegment(index.byId.get(id), before)
}

export interface HistoryBase {
  path: string
  /** The fork inherits the parent's first `endOffset` bytes. */
  endOffset: number
}

interface HistoryBaseRef {
  threadId: string
  endOffset: number
}

// Cached even when the parent is not found yet, so a retry only repeats the (rate-limited) id lookup.
const baseRefs = new TtlCache<string, HistoryBaseRef | null>(24 * HOUR, 1_000)
// The parent, once found: it was written before the file that continues it, so it does not change.
const bases = new TtlCache<string, HistoryBase>(24 * HOUR, 1_000)

/** Where a forked rollout's history starts: session_meta.history_base, resolved to the parent's file. */
export function historyBase(path: string): HistoryBase | null {
  const known = bases.get(path)
  if (known && isFile(known.path)) return known
  let ref = baseRefs.get(path)
  if (ref === undefined) {
    let line: string
    try {
      line = readFirstLine(path, 1 << 20)
    } catch {
      return null
    }
    if (!line) return null
    ref = baseRefs.set(path, historyBaseRef(line))
  }
  if (!ref) return null
  // A fork's parent normally sits in the same sessions tree as the fork itself. The parent is the segment the
  // fork or the next segment was cut from: the newest one of that session started before this file.
  const ownRoot = resolve(path, '../../../..')
  const parent =
    rolloutById(ref.threadId, ownRoot, path) ??
    (ownRoot === codexSessionsRoot() ? null : rolloutById(ref.threadId, undefined, path))
  return parent ? bases.set(path, { path: parent, endOffset: ref.endOffset }) : null
}

export function historyBaseRef(firstLine: string): HistoryBaseRef | null {
  let hb: { thread_id?: unknown; end_byte_offset?: unknown } | undefined
  try {
    hb = JSON.parse(firstLine)?.payload?.history_base
  } catch {
    const m = /"history_base":\s*\{\s*"thread_id":\s*"([0-9a-f-]{36})"[^}]*"end_byte_offset":\s*(\d+)/.exec(firstLine)
    hb = m ? { thread_id: m[1], end_byte_offset: Number(m[2]) } : undefined
  }
  if (typeof hb?.thread_id !== 'string' || typeof hb.end_byte_offset !== 'number') return null
  return { threadId: hb.thread_id, endOffset: hb.end_byte_offset }
}

let touched: { root: string; at: number; files: { path: string; mtime: number }[] } | null = null

/**
 * Rollouts appended to after `since`, newest first. A resumed conversation stays filed under the day it began,
 * so every day directory is listed; the listing is reused for a few seconds.
 */
export function touchedRollouts(since: number, root = codexSessionsRoot(), now = Date.now()): string[] {
  if (!touched || touched.root !== root || now - touched.at >= TOUCHED_SCAN_MS)
    touched = { root, at: now, files: listRollouts(root).map(path => ({ path, mtime: mtimeOf(path) })) }
  return touched.files
    .filter(f => f.mtime > since)
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => f.path)
}

/**
 * Rollouts an in-TUI `/resume` in this pane could have moved to: appended to after `current`, by an interactive
 * Codex in the pane's own folder (the picker lists that folder's sessions). Rollouts other panes show are
 * included, so that a message they share with this pane's echo makes the evidence ambiguous.
 */
export function resumeCandidates(current: string, cwd: string, root = codexSessionsRoot(), now = Date.now()): string[] {
  return touchedRollouts(mtimeOf(current), root, now).filter(path => {
    if (path === current) return false
    const meta = readRolloutMeta(path)
    return !!meta && meta.cwd === cwd && isInteractive(meta.originator)
  })
}

export interface EchoedRollout {
  path: string
  /** The rollout's newest user message, and when it was sent (ms, 0 when unknown). */
  prompt: string | null
  at: number
}

/**
 * Codex's in-TUI `/resume` moves a process to another rollout without anything herdr or argv shows, and that
 * rollout changes only with the next message. So: the newest message echoed on the pane's screen is, all of
 * it, the newest message of exactly one rollout among `others`, not the pane's own, and sent after the pane's
 * own newest message. Anything less is a guess, and the pane keeps the rollout it has: a short reply such as
 * "Continue" may be the newest message of several sessions.
 */
export function resumedRollout(
  echo: string | null,
  current: EchoedRollout,
  others: readonly EchoedRollout[],
): string | null {
  if (!echo?.trim()) return null
  const echoes = (o: EchoedRollout) => !!o.prompt && sameText(o.prompt, echo)
  if (echoes(current)) return null
  const matches = others.filter(o => o.path !== current.path && echoes(o))
  const only = matches.length === 1 ? matches[0] : undefined
  if (!only || only.at <= current.at) return null
  return only.path
}

/** The one rollout among `mine` whose newest message is the echo, all of it; null when none or several are. */
export function shownRollout(echo: string | null, mine: readonly EchoedRollout[]): string | null {
  if (!echo?.trim()) return null
  const shown = mine.filter(r => !!r.prompt && sameText(r.prompt, echo))
  return shown.length === 1 ? (shown[0]?.path ?? null) : null
}

/** Point a pane at the rollout its screen proved it resumed; that is evidence, so it counts as explicit. */
export function followRollout(pane: string, path: string): void {
  const prev = panes.get(pane)
  if (prev) panes.set(pane, { ...prev, path, created: readRolloutMeta(path)?.created ?? 0, explicit: true })
}

/** Whether the pane's rollout is known (named, or proven by its screen or its user) rather than guessed by time. */
export function rolloutProven(pane: string): boolean {
  return !!panes.get(pane)?.explicit
}

/**
 * Rollouts the pane's Codex process may be showing, newest first: interactive ones of its folder, appended to
 * since it started (or in the last day, when that is unknown), and shown by no other pane.
 */
export function paneRollouts(
  pane: string,
  cwd: string,
  startedAt: number,
  root = codexSessionsRoot(),
  now = Date.now(),
): string[] {
  const since = startedAt ? startedAt - START_SLACK_MS : now - 24 * HOUR
  return touchedRollouts(since, root, now).filter(path => {
    const meta = readRolloutMeta(path)
    return !!meta && meta.cwd === cwd && isInteractive(meta.originator) && !claimedElsewhere(path, pane)
  })
}

/** The user said which rollout the pane shows: it stays there until the screen proves a `/new` or `/resume`. */
export function pinRollout(pane: string, path: string, o: { cwd: string; startedAt: number }, now = Date.now()): void {
  const created = readRolloutMeta(path)?.created ?? 0
  panes.set(pane, { path, created, explicit: true, cwd: o.cwd, startedAt: o.startedAt, at: now })
}
