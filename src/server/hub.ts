import type { Agent, Pane, Snapshot, Tab, Workspace } from '../herdr.ts'
import type { AgentView, FirstMessage, ReplyQueue } from '../protocol.ts'
import { type PayloadOptions, toStatePayload } from './payload.ts'

export const STATE_TOPIC = 'state'

export interface HubDeps {
  snapshot(): Promise<Snapshot>
  inbox: { build(snap: Snapshot): Promise<AgentView[]> }
  firstMessages?: { flush(snap: Snapshot): Promise<void>; list(): FirstMessage[] }
  replyQueues?: { flush(snap: Snapshot): Promise<void>; list(): ReplyQueue[] }
  /** Broadcast a serialized StatePayload to every /ws/state subscriber. */
  publish(payload: string): void
  payload: PayloadOptions
  intervalMs: number
}

const MIN_PAUSE_MS = 250

/**
 * Owns the latest herdr snapshot and inbox views. `refresh()` is single-flight: a call made while one runs
 * schedules exactly one more run and resolves when that run is done, so callers always see fresh state and
 * an older run can never overwrite a newer one.
 */
export class StateHub {
  private snap: Snapshot | null = null
  private agentViews: AgentView[] = []
  private lastPayload = ''
  private running: Promise<void> | null = null
  private queued: Promise<void> | null = null
  private stopped = true

  constructor(private deps: HubDeps) {}

  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.tick().finally(() => {
        this.running = null
      })
      return this.running
    }
    this.queued ??= this.running.then(() => {
      this.queued = null
      return this.refresh()
    })
    return this.queued
  }

  private async tick(): Promise<void> {
    try {
      const snap = await this.deps.snapshot()
      const views = await this.deps.inbox.build(snap)
      this.snap = snap
      this.agentViews = views
      this.publish(snap, views)
      // After publishing: sending a first or queued message can take seconds and must not hold back the push.
      for (const queue of [this.deps.firstMessages, this.deps.replyQueues]) {
        if (!queue) continue
        const before = JSON.stringify(queue.list())
        await queue.flush(snap)
        if (JSON.stringify(queue.list()) !== before) this.publish(snap, views)
      }
    } catch (err) {
      console.error('refresh:', err instanceof Error ? err.message : err)
    }
  }

  private publish(snap: Snapshot, views: AgentView[]): void {
    const firstMessages = this.deps.firstMessages?.list() ?? []
    const replyQueues = this.deps.replyQueues?.list() ?? []
    const payload = JSON.stringify(toStatePayload(snap, views, this.deps.payload, firstMessages, replyQueues))
    if (payload === this.lastPayload) return
    this.lastPayload = payload
    this.deps.publish(payload)
  }

  /** Refresh every `intervalMs` until `stop()`. */
  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    while (!this.stopped) {
      const started = Date.now()
      await this.refresh()
      await Bun.sleep(Math.max(MIN_PAUSE_MS, this.deps.intervalMs - (Date.now() - started)))
    }
  }

  stop(): void {
    this.stopped = true
  }

  /** The last published payload, for a subscriber that just connected ('' before the first refresh). */
  get payload(): string {
    return this.lastPayload
  }

  get snapshot(): Snapshot | null {
    return this.snap
  }

  agent(pane: string): Agent | null {
    return this.snap?.agents.find(a => a.pane_id === pane) ?? null
  }

  pane(id: string): Pane | null {
    return this.snap?.panes.find(p => p.pane_id === id) ?? null
  }

  tab(id: string): Tab | null {
    return this.snap?.tabs.find(t => t.tab_id === id) ?? null
  }

  workspace(id: string): Workspace | null {
    return this.snap?.workspaces.find(w => w.workspace_id === id) ?? null
  }

  view(pane: string): AgentView | null {
    return this.agentViews.find(v => v.pane === pane) ?? null
  }
}
