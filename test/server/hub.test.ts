import { expect, test } from 'bun:test'
import type { Snapshot } from '../../src/herdr.ts'
import type { FirstMessage, StatePayload } from '../../src/protocol.ts'
import { StateHub } from '../../src/server/hub.ts'
import { fakeSnapshot, fakeView, quiet } from './fake.ts'

function setup(delayMs = 10) {
  let calls = 0
  let active = 0
  let maxActive = 0
  const published: StatePayload[] = []
  const hub = new StateHub({
    async snapshot(): Promise<Snapshot> {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      const n = calls
      await Bun.sleep(delayMs)
      active--
      const snap = fakeSnapshot()
      snap.workspaces[0]!.label = `app-${n}`
      return snap
    },
    inbox: { build: async snap => snap.agents.map(a => fakeView(a.pane_id, a.workspace_id, a.agent_status)) },
    publish: p => published.push(JSON.parse(p)),
    payload: { hidden: new Set(), home: '/home/alice', version: 'test' },
    intervalMs: 1000,
  })
  return { hub, published, stats: () => ({ calls, maxActive }) }
}

test('concurrent refreshes coalesce into one follow-up run and never overlap', async () => {
  const { hub, published, stats } = setup()
  const first = hub.refresh()
  const rest = [hub.refresh(), hub.refresh(), hub.refresh()]
  await Promise.all([first, ...rest])
  expect(stats()).toEqual({ calls: 2, maxActive: 1 })
  expect(published.map(p => p.workspaces[0]?.label)).toEqual(['app-1', 'app-2'])
  expect(hub.snapshot?.workspaces[0]?.label).toBe('app-2')
})

test('a refresh requested mid-run resolves only after fresh state', async () => {
  const { hub } = setup()
  void hub.refresh()
  await Bun.sleep(2)
  await hub.refresh()
  expect(hub.snapshot?.workspaces[0]?.label).toBe('app-2')
})

test('publishes only when the payload changes', async () => {
  const published: string[] = []
  const hub = new StateHub({
    snapshot: async () => fakeSnapshot(),
    inbox: { build: async () => [] },
    publish: p => published.push(p),
    payload: { hidden: new Set(), home: '/home/alice', version: 'test' },
    intervalMs: 1000,
  })
  await hub.refresh()
  await hub.refresh()
  expect(published).toHaveLength(1)
  expect(hub.payload).toBe(published[0] as string)
})

test('accessors read the last snapshot', async () => {
  const { hub } = setup(0)
  expect(hub.agent('w1:p1')).toBeNull()
  await hub.refresh()
  expect(hub.agent('w1:p1')?.agent).toBe('claude')
  expect(hub.agent('w1:p2')).toBeNull()
  expect(hub.pane('w1:p2')?.label).toBe('  build  ')
  expect(hub.tab('w2:t1')?.label).toBe('board')
  expect(hub.workspace('w9')).toBeNull()
  expect(hub.view('w2:p1')?.status).toBe('blocked')
})

test('runs the first-message queue after publishing, and survives errors', async () => {
  const events: string[] = []
  let fail = true
  const hub = new StateHub({
    snapshot: async () => {
      if (fail) throw new Error('herdr down')
      return fakeSnapshot()
    },
    inbox: { build: async () => [] },
    firstMessages: { flush: async () => void events.push('flush'), list: () => [] },
    publish: () => void events.push('publish'),
    payload: { hidden: new Set(), home: '/home/alice', version: 'test' },
    intervalMs: 1000,
  })
  await quiet(() => hub.refresh())
  fail = false
  await hub.refresh()
  expect(events).toEqual(['publish', 'flush'])
  expect(hub.snapshot).not.toBeNull()
})

test('first messages are in the payload, and a change from the flush is published at once', async () => {
  const payloads: StatePayload[] = []
  let list: FirstMessage[] = [{ pane: 'w1:p1', text: '/x', status: 'queued' }]
  const hub = new StateHub({
    snapshot: async () => fakeSnapshot(),
    inbox: { build: async () => [] },
    firstMessages: {
      flush: async () => {
        list = [{ ...list[0], status: 'failed', error: 'send_failed' } as FirstMessage]
      },
      list: () => list,
    },
    publish: p => void payloads.push(JSON.parse(p)),
    payload: { hidden: new Set(), home: '/home/alice', version: 'test' },
    intervalMs: 1000,
  })
  await hub.refresh()
  expect(payloads.map(p => p.firstMessages.map(m => m.status))).toEqual([['queued'], ['failed']])
})
