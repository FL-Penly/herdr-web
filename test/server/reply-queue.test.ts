import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, Snapshot } from '../../src/herdr.ts'
import { HeldError, MAX_QUEUED, ReplyQueues } from '../../src/server/reply-queue.ts'
import { quiet } from './fake.ts'

const ONE = '/c/one.jsonl'
let clock: number
let sent: [string, string][]
let sendError: Error | null
let ready: boolean
let conversation: string | null
let onSend: () => void
let lookup: Promise<void>

const snap = (status: Agent['agent_status'], completions?: number): Snapshot => ({
  workspaces: [],
  tabs: [],
  panes: [],
  agents: [
    {
      pane_id: 'w1:p1',
      tab_id: 'w1:t1',
      workspace_id: 'w1',
      cwd: '/',
      agent: 'claude',
      agent_status: status,
      completion_seq: completions,
    },
  ],
  layouts: [],
})

function queues(path?: string) {
  return new ReplyQueues({
    readScreen: async () => (ready ? 'ready' : 'busy'),
    isReady: screen => screen === 'ready',
    send: async (pane, text, wanted) => {
      onSend()
      if (sendError) throw sendError
      if (!wanted()) return false
      sent.push([pane, text])
      return true
    },
    conversation: async () => {
      await lookup
      return conversation
    },
    path,
    now: () => clock,
  })
}

/** A queue whose saves fail, quietly. */
const quietQueues = (path: string) => {
  const error = console.error
  console.error = () => {}
  try {
    return queues(path)
  } finally {
    console.error = error
  }
}

/** One hub tick a second. */
async function tick(q: ReplyQueues, s: Snapshot, times = 1) {
  for (let i = 0; i < times; i++) {
    await q.flush(s)
    clock += 1000
  }
}

beforeEach(() => {
  clock = 1_000_000
  sent = []
  sendError = null
  ready = true
  conversation = ONE
  onSend = () => {}
  lookup = Promise.resolve()
})

describe('ReplyQueues', () => {
  test('waits for the turn to end, then sends one message per turn, in order', async () => {
    const q = queues()
    q.add('w1:p1', ONE, 'first')
    q.add('w1:p1', ONE, 'second')
    await tick(q, snap('working'), 3)
    expect(sent).toEqual([])
    await tick(q, snap('done'), 2)
    expect(sent).toEqual([['w1:p1', 'first']])
    // The agent has not picked it up yet: still idle, but the second waits for it to work and finish.
    await tick(q, snap('done'), 2)
    expect(sent).toHaveLength(1)
    await tick(q, snap('working'))
    await tick(q, snap('done'), 2)
    expect(sent).toEqual([
      ['w1:p1', 'first'],
      ['w1:p1', 'second'],
    ])
    expect(q.list()).toEqual([])
  })

  test('a message that starts no turn (a local slash command) lets the next one go after a while', async () => {
    const q = queues()
    q.add('w1:p1', ONE, '/model')
    q.add('w1:p1', ONE, 'go on')
    await tick(q, snap('idle'), 2)
    await tick(q, snap('idle'), 8)
    expect(sent.map(s => s[1])).toEqual(['/model'])
    await tick(q, snap('idle'), 2)
    expect(sent.map(s => s[1])).toEqual(['/model', 'go on'])
  })

  test('not while a dialog or panel hides the input box', async () => {
    const q = queues()
    q.add('w1:p1', ONE, 'later')
    ready = false
    await tick(q, snap('idle'), 3)
    expect(sent).toEqual([])
    ready = true
    await tick(q, snap('idle'), 2)
    expect(sent).toHaveLength(1)
  })

  test('text typed in the terminal holds the queue; sent from there as a message, the queue follows its turn', async () => {
    const q = queues()
    q.add('w1:p1', ONE, 'mine')
    sendError = new HeldError('terminal_draft')
    await tick(q, snap('idle'), 2)
    expect(q.list()[0]).toMatchObject({ held: 'terminal_draft', paused: false })
    sendError = null
    await tick(q, snap('working'))
    await tick(q, snap('done'), 2)
    expect(sent).toEqual([['w1:p1', 'mine']])
  })

  test('terminal input gone without a turn (a command such as /new) pauses instead of sending', async () => {
    const q = queues()
    q.add('w1:p1', ONE, 'not into a new session')
    sendError = new HeldError('terminal_draft')
    await tick(q, snap('idle'), 2)
    sendError = null
    await tick(q, snap('idle'), 4)
    expect(sent).toEqual([])
    expect(q.list()[0]).toMatchObject({ paused: true, held: 'terminal_input' })
    q.resume('w1:p1')
    await tick(q, snap('idle'), 2)
    expect(sent).toHaveLength(1)
  })

  test('a turn that started and ended between two looks still counts: no pause', async () => {
    const q = queues()
    q.add('w1:p1', ONE, 'after a quick one')
    sendError = new HeldError('terminal_draft')
    await tick(q, snap('idle', 7), 2)
    sendError = null
    await tick(q, snap('idle', 8), 2)
    expect(sent).toEqual([['w1:p1', 'after a quick one']])
  })

  test('held by terminal text when the server restarts, the queue still asks if that text went without a turn', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'queue-')), 'queue.json')
    const before = queues(path)
    before.add('w1:p1', ONE, 'old')
    sendError = new HeldError('terminal_draft')
    await tick(before, snap('idle', 3), 2)
    sendError = null
    const after = queues(path)
    await tick(after, snap('idle', 3), 4)
    expect(sent).toEqual([])
    expect(after.list()[0]).toMatchObject({ paused: true, held: 'terminal_input' })
  })

  test('a pause that lands while the conversation is looked up stops the send', async () => {
    const q = queues()
    q.add('w1:p1', ONE, 'too late')
    await tick(q, snap('idle'))
    let release = () => {}
    lookup = new Promise(resolve => {
      release = resolve
    })
    const flushing = q.flush(snap('idle'))
    q.pause('w1:p1')
    release()
    await flushing
    expect(sent).toEqual([])
    expect(q.list()[0]).toMatchObject({ paused: true })
  })

  test('a queue that cannot be saved before a send sends nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-'))
    writeFileSync(join(dir, 'file'), '')
    const q = quietQueues(join(dir, 'file', 'queue.json'))
    await quiet(async () => {
      q.add('w1:p1', ONE, 'unsaved')
      await tick(q, snap('idle'), 3)
    })
    expect(sent).toEqual([])
    expect(q.list()[0]).toMatchObject({ paused: true, held: 'send_failed' })
  })

  test('a failed send pauses the queue with the message still first', async () => {
    const q = queues()
    q.add('w1:p1', ONE, 'mine')
    sendError = new Error('herdr timed out')
    await quiet(() => tick(q, snap('idle'), 4))
    expect(q.list()).toEqual([
      {
        pane: 'w1:p1',
        items: [{ id: expect.any(String), text: 'mine' }],
        paused: true,
        held: 'send_failed',
        detail: 'herdr timed out',
      },
    ])
    sendError = null
    q.resume('w1:p1')
    await tick(q, snap('idle'), 2)
    expect(sent).toEqual([['w1:p1', 'mine']])
  })

  test('paused, removed and full', async () => {
    const q = queues()
    const a = q.add('w1:p1', ONE, 'a')
    q.add('w1:p1', ONE, 'b')
    q.pause('w1:p1')
    await tick(q, snap('idle'), 3)
    expect(sent).toEqual([])
    expect(q.remove('w1:p1', a)).toBe(true)
    expect(q.remove('w1:p1', a)).toBe(false)
    q.resume('w1:p1')
    await tick(q, snap('idle'), 2)
    expect(sent.map(s => s[1])).toEqual(['b'])
    for (let i = 0; i < MAX_QUEUED; i++) q.add('w1:p2', null, `${i}`)
    expect(() => q.add('w1:p2', null, 'one more')).toThrow()
  })

  test('a pane that moved to another conversation pauses; going on sends into the one it shows now', async () => {
    const q = queues()
    q.add('w1:p1', ONE, 'for the old one')
    conversation = '/c/two.jsonl'
    await tick(q, snap('idle'), 5)
    expect(sent).toEqual([])
    expect(q.list()[0]).toMatchObject({ paused: true, held: 'session_changed' })
    q.resume('w1:p1')
    await tick(q, snap('idle'), 2)
    expect(sent).toEqual([['w1:p1', 'for the old one']])
  })

  test('why a queue stopped survives a restart, so one go-ahead is enough', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'queue-')), 'queue.json')
    queues(path).add('w1:p1', ONE, 'after the restart')
    conversation = '/c/two.jsonl'
    const before = queues(path)
    await tick(before, snap('idle'), 3)
    const after = queues(path)
    expect(after.list()[0]).toMatchObject({ paused: true, held: 'session_changed' })
    after.resume('w1:p1')
    await tick(after, snap('idle'), 2)
    expect(sent).toEqual([['w1:p1', 'after the restart']])
  })

  test('nothing goes out while the conversation is unknown; one queued without it takes the first seen', async () => {
    const q = queues()
    q.add('w1:p1', null, 'early')
    conversation = null
    await tick(q, snap('idle'), 4)
    expect(sent).toEqual([])
    conversation = ONE
    await tick(q, snap('idle'), 2)
    expect(sent).toEqual([['w1:p1', 'early']])
  })

  test('a pane gone for a while drops its queue', async () => {
    const q = queues()
    q.add('w1:p1', ONE, 'orphan')
    await tick(q, { ...snap('idle'), agents: [] }, 40)
    expect(q.list()).toEqual([])
  })

  test('kept across restarts; one stopped while a message was being typed comes back paused, maybe sent', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'queue-')), 'queue.json')
    const q = queues(path)
    q.add('w1:p1', ONE, 'survives')
    const item = { id: expect.any(String), text: 'survives' }
    expect(queues(path).list()).toEqual([{ pane: 'w1:p1', items: [item], paused: false }])
    let onDisk: object[] = []
    onSend = () => {
      onDisk = JSON.parse(readFileSync(path, 'utf8'))
    }
    await tick(q, snap('idle'), 2)
    expect(onDisk).toEqual([expect.objectContaining({ sending: expect.any(String) })])
    writeFileSync(path, JSON.stringify([...onDisk, { pane: 5 }, 'junk']))
    expect(queues(path).list()).toEqual([{ pane: 'w1:p1', items: [item], paused: true, held: 'maybe_sent' }])
  })
})
