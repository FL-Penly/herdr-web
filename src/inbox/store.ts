import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from '../config.ts'

/** Panes missing from the snapshot keep their state this long, so a herdr restart or a partial snapshot loses nothing. */
export const PRUNE_GRACE_MS = 10 * 60_000

interface State {
  since: Record<string, { key: string; at: number }>
  acked: Record<string, string>
  snoozed: Record<string, { key: string; until: number }>
  /** Pane → identityKey of the agent the entries above belong to. */
  owner: Record<string, string>
}

const empty = (): State => ({ since: {}, acked: {}, snoozed: {}, owner: {} })
const record = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/** Per-pane inbox state persisted in `state.json`: since-timestamps, acks and snoozes. */
export class InboxStore {
  private state: State
  private dirty = false
  private lastSeen = new Map<string, number>()

  constructor(readonly path = join(config.configDir, 'state.json')) {
    this.state = this.load()
  }

  /**
   * Record that `pane` runs `identity` with status `sinceKey`; returns when that status began and
   * whether the pane is new. Entries left by another agent that had the same pane id are dropped first.
   */
  observe(pane: string, identity: string, sinceKey: string, now: number): { since: number; firstSeen: boolean } {
    this.lastSeen.set(pane, now)
    if (this.state.owner[pane] !== identity) {
      if (isOtherAgent(this.state.owner[pane], identity)) this.forget(pane)
      this.state.owner[pane] = identity
      this.dirty = true
    }
    const prev = this.state.since[pane]
    if (prev?.key === sinceKey) return { since: prev.at, firstSeen: false }
    this.state.since[pane] = { key: sinceKey, at: now }
    this.dirty = true
    return { since: now, firstSeen: !prev }
  }

  setSince(pane: string, at: number) {
    const entry = this.state.since[pane]
    if (!entry || entry.at === at) return
    entry.at = at
    this.dirty = true
  }

  isAcked(pane: string, key: string): boolean {
    return this.state.acked[pane] === key
  }

  snoozedUntil(pane: string, key: string, now: number): number | null {
    const s = this.state.snoozed[pane]
    return s && s.key === key && s.until > now ? s.until : null
  }

  ack(pane: string, key: string) {
    this.state.acked[pane] = key
    delete this.state.snoozed[pane]
    this.dirty = true
    this.flush()
  }

  unack(pane: string) {
    delete this.state.acked[pane]
    delete this.state.snoozed[pane]
    this.dirty = true
    this.flush()
  }

  snooze(pane: string, key: string, until: number) {
    this.state.snoozed[pane] = { key, until }
    this.dirty = true
    this.flush()
  }

  prune(live: Set<string>, now: number): string[] {
    const gone: string[] = []
    const { since, acked, snoozed, owner } = this.state
    const panes = new Set([since, acked, snoozed, owner].flatMap(Object.keys).concat([...this.lastSeen.keys()]))
    for (const pane of panes) {
      if (live.has(pane)) continue
      const seen = this.lastSeen.get(pane)
      if (seen === undefined) this.lastSeen.set(pane, now)
      else if (now - seen > PRUNE_GRACE_MS) {
        this.forget(pane)
        this.lastSeen.delete(pane)
        gone.push(pane)
      }
    }
    return gone
  }

  /** Write state.json if anything changed, via a temp file and rename so a crash never truncates it. */
  flush() {
    if (!this.dirty) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
      renameSync(tmp, this.path)
      this.dirty = false
    } catch (err) {
      console.warn(`inbox: cannot save ${this.path}: ${(err as Error).message}`)
    }
  }

  private forget(pane: string) {
    delete this.state.since[pane]
    delete this.state.acked[pane]
    delete this.state.snoozed[pane]
    delete this.state.owner[pane]
    this.dirty = true
  }

  private load(): State {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      return empty()
    }
    try {
      const raw = JSON.parse(text)
      return {
        since: record(raw?.since),
        acked: record(raw?.acked),
        snoozed: record(raw?.snoozed),
        owner: record(raw?.owner),
      } as State
    } catch (err) {
      console.warn(`inbox: ignoring unreadable ${this.path}: ${(err as Error).message}`)
      return empty()
    }
  }
}

// Session ids come and go (herdr may not know one yet), so only a different agent kind or two different
// known sessions mean a different agent.
function isOtherAgent(prev: string | undefined, next: string): boolean {
  if (prev === undefined) return false
  const [prevKind, prevSession = ''] = split(prev)
  const [nextKind, nextSession = ''] = split(next)
  return prevKind !== nextKind || (!!prevSession && !!nextSession && prevSession !== nextSession)
}

function split(identity: string): [string, string] {
  const at = identity.indexOf(':')
  return at < 0 ? [identity, ''] : [identity.slice(0, at), identity.slice(at + 1)]
}
