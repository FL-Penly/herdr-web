import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type Snapshot, isIdle } from '../herdr.ts'
import type { ReplyQueue } from '../protocol.ts'

export interface ReplyQueueDeps {
  readScreen(pane: string): Promise<string>
  /** The agent shows its idle input box: no numbered dialog, no trust prompt. */
  isReady(screen: string): boolean
  /**
   * Type the message into the input box and submit it, under the pane's lock, if `wanted()` still says so once
   * the lock is held and the box checked; false when it did not. Throws `HeldError` when it must wait (text typed
   * in the terminal sits in the box); anything else is a failure.
   */
  send(pane: string, text: string, wanted: () => boolean): Promise<boolean>
  /**
   * The conversation (session id) the pane shows now, null while unknown. It follows Claude Code's `/clear` and
   * `/resume`, and Codex's `/new` once that wrote its first message.
   */
  conversation(pane: string): Promise<string | null>
  /** A pane something else types into is tried again on the next tick. */
  busy?(pane: string): boolean
  /** Kept across restarts. */
  path?: string
  now?: () => number
}

/** The send has to wait, not fail: the reason is shown and the next tick tries again. */
export class HeldError extends Error {
  constructor(readonly reason: 'terminal_draft') {
    super(reason)
  }
}

// Claude Code paints its prompt a beat before it accepts input; wait for two ready ticks in a row.
const READY_TICKS = 2
/**
 * After a send the agent may not have started yet: the next message waits until it was seen working, or this
 * long for one that never works (a local slash command such as `/model`).
 */
const SETTLE_MS = 8_000
/** A pane missing from the snapshot right after a restart may only be newer than that snapshot. */
const GONE_GRACE_MS = 30_000
export const MAX_QUEUED = 20

interface Item {
  id: string
  text: string
}

interface Queue {
  /** The conversation the messages were written for; one the pane left for another is not sent into. */
  conversation: string | null
  items: Item[]
  paused: boolean
  held?: ReplyQueue['held']
  detail?: string
  ready: number
  sentAt: number
  seenWorking: boolean
  seenAt: number
  /** Saved before typing it, so a restart midway knows the message may have gone out. */
  sending?: string
  /**
   * Text typed in the terminal held the queue, at herdr's completion count then (null without one), and no turn
   * was seen since. Gone without a turn, it was a command (Codex's `/new` changes the conversation before any
   * file says so) or deleted: ask before going on. Kept across restarts: the terminal may change meanwhile.
   */
  draftAt?: number | null
}

/** Why a queue stopped and waits for the user, kept across restarts. */
const STOPPED: ReadonlySet<ReplyQueue['held']> = new Set([
  'send_failed',
  'maybe_sent',
  'session_changed',
  'terminal_input',
])

/**
 * Messages that wait for the agent's turn to end (Codex's Tab queue, which Claude Code lacks), sent one per
 * turn in order, under the same rules as a reply. Kept here rather than in either TUI, so both agents behave
 * the same and every browser sees one queue. A web interrupt pauses a pane's queue; so do a failed send, a
 * restart in the middle of one (both leave the message first: it may have gone out, and is never retried on
 * its own), a pane that moved to another conversation, and terminal input that ended without a turn.
 */
export class ReplyQueues {
  private queues = new Map<string, Queue>()
  private now: () => number
  private nextId = 1

  constructor(private deps: ReplyQueueDeps) {
    this.now = deps.now ?? Date.now
    this.load()
  }

  add(pane: string, conversation: string | null, text: string): string {
    let queue = this.queues.get(pane)
    if (!queue) {
      queue = { conversation, items: [], paused: false, ready: 0, sentAt: 0, seenWorking: true, seenAt: this.now() }
      this.queues.set(pane, queue)
    }
    queue.conversation ??= conversation
    if (queue.items.length >= MAX_QUEUED) throw new Error(`At most ${MAX_QUEUED} messages wait for one agent`)
    const id = `${this.now().toString(36)}-${this.nextId++}`
    queue.items.push({ id, text })
    this.save()
    return id
  }

  /** Taken out (deleted, or moved back to the composer); false when it was sent or removed meanwhile. */
  remove(pane: string, id: string): boolean {
    const queue = this.queues.get(pane)
    const at = queue?.items.findIndex(i => i.id === id) ?? -1
    if (!queue || at < 0) return false
    queue.items.splice(at, 1)
    if (at === 0) Object.assign(queue, { held: undefined, detail: undefined })
    this.drop(pane, queue)
    this.save()
    return true
  }

  pause(pane: string): void {
    const queue = this.queues.get(pane)
    if (!queue?.items.length || queue.paused) return
    queue.paused = true
    this.save()
  }

  /** Go on; after a change of conversation, into the one the pane shows now. */
  resume(pane: string): void {
    const queue = this.queues.get(pane)
    if (!queue) return
    if (queue.held === 'session_changed') queue.conversation = null
    Object.assign(queue, { paused: false, held: undefined, detail: undefined, ready: 0, draftAt: undefined })
    this.save()
  }

  list(): ReplyQueue[] {
    return [...this.queues].map(([pane, q]) => ({
      pane,
      items: q.items.map(i => ({ ...i })),
      paused: q.paused,
      ...(q.held ? { held: q.held } : {}),
      ...(q.detail ? { detail: q.detail } : {}),
    }))
  }

  /** Called once per hub refresh, which never overlaps another: flushes never overlap either. */
  async flush(snap: Snapshot): Promise<void> {
    for (const [pane, queue] of [...this.queues]) {
      const agent = snap.agents.find(a => a.pane_id === pane)
      if (!agent) {
        if (this.now() - queue.seenAt > GONE_GRACE_MS) {
          this.queues.delete(pane)
          this.save()
        }
        continue
      }
      queue.seenAt = this.now()
      if (agent.agent_status === 'working') queue.seenWorking = true
      // A turn ran since the terminal held the queue, even one that started and ended between two looks.
      const completions = agent.completion_seq ?? null
      const turned = completions !== null && queue.draftAt != null && completions > queue.draftAt
      if (agent.agent_status === 'working' || turned) queue.draftAt = undefined
      const item = queue.items[0]
      if (!item || queue.paused || this.deps.busy?.(pane)) continue
      const settled = queue.seenWorking || this.now() - queue.sentAt > SETTLE_MS
      const screen = settled && isIdle(agent.agent_status) ? await this.deps.readScreen(pane).catch(() => '') : ''
      if (queue.items[0] !== item) continue
      queue.ready = screen && this.deps.isReady(screen) ? queue.ready + 1 : 0
      if (queue.ready < READY_TICKS) continue
      const conversation = await this.deps.conversation(pane).catch(() => null)
      if (!conversation || queue.items[0] !== item) {
        queue.ready = 0
        continue
      }
      queue.conversation ??= conversation
      if (conversation !== queue.conversation) {
        this.stop(queue, 'session_changed')
        continue
      }
      queue.sending = item.id
      if (!this.save()) {
        queue.sending = undefined
        this.stop(queue, 'send_failed', 'The queue could not be saved, so nothing was sent')
        continue
      }
      // Checked again under the lock: a pause, a removal or the terminal may have come between.
      const wanted = () => {
        if (this.queues.get(pane) !== queue || queue.paused || queue.items[0] !== item) return false
        if (queue.draftAt === undefined) return true
        this.stop(queue, 'terminal_input')
        return false
      }
      try {
        if (await this.deps.send(pane, item.text, wanted)) {
          // Taken out of the queue while it was being typed: it went out all the same.
          const at = queue.items.indexOf(item)
          if (at >= 0) queue.items.splice(at, 1)
          Object.assign(queue, { held: undefined, detail: undefined, ready: 0, sentAt: this.now(), seenWorking: false })
        }
      } catch (err) {
        if (err instanceof HeldError)
          Object.assign(queue, { held: err.reason, ready: 0, draftAt: queue.draftAt ?? completions })
        else {
          const detail = err instanceof Error ? err.message : String(err)
          console.error('queued reply', pane, detail)
          Object.assign(queue, { held: 'send_failed', detail, paused: true })
        }
      }
      queue.sending = undefined
      this.drop(pane, queue)
      this.save()
    }
  }

  private stop(queue: Queue, held: ReplyQueue['held'], detail?: string): void {
    Object.assign(queue, { paused: true, held, detail, ready: 0 })
    this.save()
  }

  private drop(pane: string, queue: Queue): void {
    if (!queue.items.length) this.queues.delete(pane)
  }

  private load(): void {
    if (!this.deps.path) return
    let saved: unknown
    try {
      saved = JSON.parse(readFileSync(this.deps.path, 'utf8'))
    } catch {
      return
    }
    if (!Array.isArray(saved)) return
    for (const q of saved) {
      if (typeof q?.pane !== 'string' || !Array.isArray(q.items)) continue
      const items = q.items
        .filter((i: unknown): i is Item => typeof (i as Item)?.id === 'string' && typeof (i as Item)?.text === 'string')
        .slice(0, MAX_QUEUED)
      if (!items.length) continue
      // A queue that was sending when the server stopped is paused: that message may have gone out.
      const midway = items.some((i: Item) => i.id === q.sending)
      const held = midway ? 'maybe_sent' : STOPPED.has(q.held) ? (q.held as ReplyQueue['held']) : undefined
      this.queues.set(q.pane, {
        conversation: typeof q.conversation === 'string' ? q.conversation : null,
        items,
        paused: q.paused === true || !!held,
        ...(held ? { held } : {}),
        ...(held && !midway && typeof q.detail === 'string' ? { detail: q.detail } : {}),
        ...(q.draftAt === null || typeof q.draftAt === 'number' ? { draftAt: q.draftAt } : {}),
        ready: 0,
        sentAt: 0,
        seenWorking: true,
        seenAt: this.now(),
      })
    }
  }

  /** False when the file could not be written. */
  private save(): boolean {
    if (!this.deps.path) return true
    const data = [...this.queues].map(([pane, q]) => ({
      pane,
      conversation: q.conversation,
      items: q.items,
      paused: q.paused,
      ...(STOPPED.has(q.held) ? { held: q.held, detail: q.detail } : {}),
      ...(q.sending ? { sending: q.sending } : {}),
      ...(q.draftAt !== undefined ? { draftAt: q.draftAt } : {}),
    }))
    try {
      mkdirSync(dirname(this.deps.path), { recursive: true })
      const tmp = `${this.deps.path}.tmp`
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
      renameSync(tmp, this.deps.path)
      return true
    } catch (err) {
      console.error('reply queue:', err instanceof Error ? err.message : err)
      return false
    }
  }
}
