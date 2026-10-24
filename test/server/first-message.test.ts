import { expect, test } from 'bun:test'
import type { Snapshot } from '../../src/herdr.ts'
import { KeyedMutex } from '../../src/lib/mutex.ts'
import { EXPIRE_MS, FirstMessageQueue } from '../../src/server/first-message.ts'
import { fakeSnapshot } from './fake.ts'

function idle(snap: Snapshot): Snapshot {
  return { ...snap, agents: snap.agents.map(a => ({ ...a, agent_status: 'idle' as const })) }
}

function setup(screen = '❯ ', { fail = false, locks }: { fail?: boolean; locks?: KeyedMutex } = {}) {
  let clock = 0
  const sent: [string, string][] = []
  const reads: string[] = []
  const queue = new FirstMessageQueue({
    readScreen: async pane => {
      reads.push(pane)
      return screen
    },
    prompt: async (pane, text) => {
      sent.push([pane, text])
      if (fail) throw new Error('herdr agent prompt: timed out after 10s')
    },
    isReady: s => s.startsWith('❯'),
    locks,
    now: () => clock,
  })
  return { queue, sent, reads, tick: (ms: number) => (clock += ms) }
}

const quietly = async (run: () => Promise<void>) => {
  const error = console.error
  console.error = () => {}
  try {
    await run()
  } finally {
    console.error = error
  }
}

test('sends after two ready refreshes, then forgets the pane', async () => {
  const { queue, sent, reads } = setup()
  queue.add('w1:p1', '/goal ship it')
  const snap = idle(fakeSnapshot())
  await queue.flush(snap)
  expect(sent).toEqual([])
  await queue.flush(snap)
  expect(sent).toEqual([['w1:p1', '/goal ship it']])
  await queue.flush(snap)
  expect(sent).toHaveLength(1)
  expect(reads).toHaveLength(2)
})

test('waits while the agent is busy or the screen is not ready', async () => {
  const busy = setup()
  busy.queue.add('w1:p1', '/x')
  for (let i = 0; i < 3; i++) await busy.queue.flush(fakeSnapshot())
  expect(busy.sent).toEqual([])

  const dialog = setup('Do you trust the files in this folder?')
  dialog.queue.add('w1:p1', '/x')
  for (let i = 0; i < 3; i++) await dialog.queue.flush(idle(fakeSnapshot()))
  expect(dialog.sent).toEqual([])
})

test('a not-ready refresh resets the count', async () => {
  let screen = '❯ '
  const sent: string[] = []
  const queue = new FirstMessageQueue({
    readScreen: async () => screen,
    prompt: async (_, text) => {
      sent.push(text)
    },
    isReady: s => s.startsWith('❯'),
  })
  queue.add('w1:p1', '/x')
  const snap = idle(fakeSnapshot())
  await queue.flush(snap)
  screen = 'loading'
  await queue.flush(snap)
  screen = '❯ '
  await queue.flush(snap)
  expect(sent).toEqual([])
  await queue.flush(snap)
  expect(sent).toEqual(['/x'])
})

test('is listed as queued until delivered', async () => {
  const { queue } = setup()
  queue.add('w1:p1', '/goal ship it')
  expect(queue.list()).toEqual([{ pane: 'w1:p1', text: '/goal ship it', status: 'queued' }])
  const snap = idle(fakeSnapshot())
  await queue.flush(snap)
  await queue.flush(snap)
  expect(queue.list()).toEqual([])
})

test('a failed send stays as failed, with its text, and is not retried blindly', async () => {
  const { queue, sent } = setup('❯ ', { fail: true })
  queue.add('w1:p1', '/goal important')
  await quietly(async () => {
    for (let i = 0; i < 5; i++) await queue.flush(idle(fakeSnapshot()))
  })
  expect(sent).toHaveLength(1)
  expect(queue.list()).toEqual([
    {
      pane: 'w1:p1',
      text: '/goal important',
      status: 'failed',
      error: 'send_failed',
      detail: 'herdr agent prompt: timed out after 10s',
    },
  ])
  queue.dismiss('w1:p1')
  expect(queue.list()).toEqual([])
})

test('expires to failed after 15 minutes instead of vanishing', async () => {
  const { queue, sent, reads, tick } = setup()
  queue.add('w1:p1', '/x')
  tick(EXPIRE_MS + 1)
  for (let i = 0; i < 3; i++) await queue.flush(idle(fakeSnapshot()))
  expect(reads).toEqual([])
  expect(sent).toEqual([])
  expect(queue.list()).toMatchObject([{ pane: 'w1:p1', text: '/x', status: 'failed', error: 'expired' }])
})

test('is dropped once its pane is gone, but not while the pane may be newer than the snapshot', async () => {
  const { queue, tick } = setup('loading')
  queue.add('w9:p9', '/x')
  await queue.flush(fakeSnapshot())
  expect(queue.list()).toHaveLength(1)
  tick(60_000)
  await queue.flush(fakeSnapshot())
  expect(queue.list()).toEqual([])
})

test('waits while an action types into the pane, then sends under its lock', async () => {
  const locks = new KeyedMutex()
  const { queue, sent } = setup('❯ ', { locks })
  queue.add('w1:p1', '/x')
  const snap = idle(fakeSnapshot())
  let release = () => {}
  const held = locks.run('w1:p1', () => new Promise<void>(r => (release = r)))
  for (let i = 0; i < 3; i++) await queue.flush(snap)
  expect(sent).toEqual([])
  release()
  await held
  await queue.flush(snap)
  await queue.flush(snap)
  expect(sent).toEqual([['w1:p1', '/x']])
})

/** A queue whose screen read can be held open, to race it against dismiss() and a reply. */
function racing() {
  const locks = new KeyedMutex()
  const sent: string[] = []
  let hold: ((screen: string) => void) | null = null
  const queue = new FirstMessageQueue({
    readScreen: () => new Promise<string>(r => (hold = r)),
    prompt: async (_, text) => {
      sent.push(text)
    },
    isReady: s => s.startsWith('❯'),
    locks,
  })
  const ready = async (flush: Promise<void>) => {
    await Bun.sleep(0)
    hold?.('❯ ')
    await flush
  }
  return { queue, locks, sent, ready, release: () => hold?.('❯ ') }
}

test('a message dismissed while the screen is read is not sent', async () => {
  const { queue, sent, release } = racing()
  queue.add('w1:p1', 'old first message')
  const snap = idle(fakeSnapshot())
  const first = queue.flush(snap)
  await Bun.sleep(0)
  release()
  await first
  const second = queue.flush(snap)
  await Bun.sleep(0)
  queue.dismiss('w1:p1')
  expect(queue.list()).toEqual([])
  release()
  await second
  expect(sent).toEqual([])
})

test('a reply that goes through while the screen is read cancels the queued message', async () => {
  const { queue, locks, sent, ready } = racing()
  queue.add('w1:p1', 'old first message')
  const snap = idle(fakeSnapshot())
  await ready(queue.flush(snap))
  const second = queue.flush(snap)
  await Bun.sleep(0)
  // What the reply action does under the pane's lock: prompt, then dismiss the first message.
  const reply = locks.run('w1:p1', async () => {
    await Bun.sleep(5)
    sent.push('reply')
    queue.dismiss('w1:p1')
  })
  await ready(second)
  await reply
  expect(sent).toEqual(['reply'])
  expect(queue.list()).toEqual([])
})

test('a message replaced while the screen is read sends only the new one, later', async () => {
  const { queue, sent, ready } = racing()
  queue.add('w1:p1', 'old')
  const snap = idle(fakeSnapshot())
  await ready(queue.flush(snap))
  const second = queue.flush(snap)
  await Bun.sleep(0)
  queue.add('w1:p1', 'new')
  await ready(second)
  expect(sent).toEqual([])
  await ready(queue.flush(snap))
  await ready(queue.flush(snap))
  expect(sent).toEqual(['new'])
})
