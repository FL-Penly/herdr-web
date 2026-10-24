import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastReply } from '../../src/agents/index.ts'
import { MAX_TURNS, buildTurns, isUnansweredTurn, readThread } from '../../src/agents/thread.ts'
import { type Entry, ItemLog, MAX_ITEMS } from '../../src/agents/transcript.ts'
import type { Item, Turn } from '../../src/protocol.ts'
import { fixture } from './helpers.ts'

const user = (text: string, ts: number): Item => ({ type: 'user', text, images: 0, ts })
const text = (t: string, ts: number, forkAt?: string): Item => ({
  type: 'text',
  text: t,
  ts,
  ...(forkAt ? { forkAt } : {}),
})

describe('buildTurns', () => {
  const entries: Entry[] = [
    { item: text('orphan', 5), start: 0 },
    { item: user('one', 10), start: 100 },
    { item: text('a', 12, 'm1'), start: 200 },
    { item: { type: 'think', ts: 0 }, start: 250 },
    { item: user('two', 20), start: 300 },
    { item: text('b', 25, 'm2'), start: 400 },
    { item: text('c', 27), start: 500 },
  ]

  test('groups steps under user messages, ids from offsets, last fork mark wins', () => {
    const { turns, more } = buildTurns(entries, 10)
    expect(more).toBe(0)
    expect(turns.map(t => [t.id, t.user?.text ?? null, t.steps.length, t.start, t.end, t.forkAt])).toEqual([
      ['pre-0', null, 1, 5, 5, undefined],
      ['100', 'one', 2, 10, 12, 'm1'],
      ['300', 'two', 2, 20, 27, 'm2'],
    ])
  })

  test('maxTurns keeps the newest; more counts only the older turns a larger request returns', () => {
    const { turns, more } = buildTurns(entries, 1)
    expect(turns.map(t => t.id)).toEqual(['300'])
    expect(more).toBe(2)
    expect(buildTurns(entries, 0).turns).toEqual([])
  })

  test('ids are stable when more rows arrive and when items share a timestamp', () => {
    const before = buildTurns(entries, 10).turns.map(t => t.id)
    const after = buildTurns([...entries, { item: user('three', 20), start: 600 }], 10).turns.map(t => t.id)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(new Set(after).size).toBe(after.length)
  })

  test('items inherited from a fork base get distinct ids', () => {
    const { turns } = buildTurns(
      [
        { item: user('p', 1), start: 100, source: 1 },
        { item: user('c', 2), start: 100 },
      ],
      10,
    )
    expect(turns.map(t => t.id)).toEqual(['b1-100', '100'])
  })
})

describe('ItemLog', () => {
  test('trims at a user message and reports dropped turns and tools', () => {
    const dropped: string[] = []
    const log = new ItemLog(t => dropped.push(t.id))
    log.push(user('first', 0), 0)
    log.push({ type: 'tool', id: 'old', tool: 'cmd', op: 'run', detail: '', status: 'running', ts: 0 }, 1)
    for (let i = 0; i < MAX_ITEMS; i++) log.push(i % 10 === 0 ? user(`u${i}`, i) : text(`t${i}`, i), i + 2)
    expect(log.entries.length).toBeLessThanOrEqual(MAX_ITEMS)
    expect(log.entries[0]?.item).toMatchObject({ type: 'user', text: 'u0' })
    expect(dropped).toEqual(['old'])
    expect(log.droppedTurns).toBe(1)
  })
})

describe('readThread', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  test('Claude transcript: turns, meta, version', () => {
    const path = fixture('claude', 'session.jsonl')
    const thread = readThread('claude', path, 30)
    expect(thread.turns).toHaveLength(2)
    expect(thread.turns[0]?.forkAt).toBe('aaaaaaaa-0000-4000-8000-000000000002')
    expect(thread.meta).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', path, pending: [], goal: null })
    expect(thread.meta.version).toBe(`${path}:${readFileSync(path).length}`)
  })

  test('Codex fork: the parent prefix up to history_base is prepended', () => {
    const day = fixture('codex', 'sessions', '2026', '01', '02')
    const parent = join(day, 'rollout-2026-01-02T10-00-00-33333333-3333-4333-8333-333333333333.jsonl')
    const child = join(day, 'rollout-2026-01-02T10-05-00-44444444-4444-4444-8444-444444444444.jsonl')
    const thread = readThread('codex', child, 10)
    expect(thread.turns.map(t => t.user?.text)).toEqual(['Parent question one', 'Child question'])
    expect(thread.turns[0]?.id).toStartWith('b1-')
    expect(thread.turns[0]?.forkAt).toBe(`${parent}#922`)
    expect(thread.turns[1]?.forkAt).toBe(`${child}#${readFileSync(child).length}`)
  })

  test('reads incrementally and rebuilds after a rewrite', () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-'))
    const path = join(dir, 's.jsonl')
    const row = (r: object) => `${JSON.stringify(r)}\n`
    writeFileSync(path, row({ type: 'user', message: { content: 'hello' }, timestamp: '2026-01-01T00:00:00Z' }))
    expect(readThread('claude', path, 5).turns).toHaveLength(1)
    appendFileSync(path, row({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: '你好' }] } }))
    const t = readThread('claude', path, 5)
    expect(t.turns[0]?.steps.map(s => s.type === 'text' && s.text)).toEqual(['你好'])
    writeFileSync(path, row({ type: 'user', message: { content: 'replaced' } }))
    expect(readThread('claude', path, 5).turns.map(x => x.user?.text)).toEqual(['replaced'])
  })
})

describe('history limits', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })
  const row = (r: object) => `${JSON.stringify(r)}\n`
  const turn = (n: number, replies: number) =>
    row({ type: 'user', message: { content: `question ${n}` } }) +
    Array.from({ length: replies }, (_, i) =>
      row({
        type: 'assistant',
        uuid: `u${n}-${i}`,
        message: { content: [{ type: 'text', text: `answer ${n}.${i}` }] },
      }),
    ).join('')

  test('turns dropped by the item ceiling are truncated history, never "more"', () => {
    dir = mkdtempSync(join(tmpdir(), 'limits-'))
    const path = join(dir, 'long.jsonl')
    const turns = Math.ceil(MAX_ITEMS / 2) + 10
    writeFileSync(path, Array.from({ length: turns }, (_, n) => turn(n, 1)).join(''))
    const all = readThread('claude', path, MAX_TURNS)
    expect(all.meta).toMatchObject({ truncated: true, maxTurns: MAX_TURNS })
    expect(all.more).toBe(0)
    const page = readThread('claude', path, 30)
    expect(page.turns).toHaveLength(30)
    // Asking for exactly `more` more returns all of them, and then there is nothing left to ask for.
    const next = readThread('claude', path, 30 + page.more)
    expect(next.more).toBe(0)
    expect(next.turns.length).toBe(30 + page.more)
  })

  test('a request past MAX_TURNS is clamped; turns beyond it are truncated history', () => {
    dir = mkdtempSync(join(tmpdir(), 'limits-'))
    const path = join(dir, 'many.jsonl')
    writeFileSync(path, Array.from({ length: MAX_TURNS + 5 }, (_, n) => turn(n, 0)).join(''))
    const thread = readThread('claude', path, MAX_TURNS + 100)
    expect(thread.turns).toHaveLength(MAX_TURNS)
    expect(thread.more).toBe(0)
    expect(thread.meta.truncated).toBe(true)
    expect(readThread('claude', path, MAX_TURNS - 10).more).toBe(10)
  })

  test('a short transcript is not truncated', () => {
    expect(readThread('claude', fixture('claude', 'session.jsonl'), 30).meta.truncated).toBe(false)
  })
})

describe('lastReply', () => {
  test('the last text of the newest turn', () => {
    expect(lastReply('claude', fixture('claude', 'session.jsonl'))).toEqual({
      text: 'Thanks!',
      at: Date.parse('2026-01-02T10:00:33.000Z'),
    })
  })

  test('null while the newest user message has no reply', () => {
    expect(lastReply('codex', fixture('codex', 'rollout.jsonl'))).toBeNull()
    expect(lastReply('claude', fixture('claude', 'missing.jsonl'))).toBeNull()
  })
})

describe('isUnansweredTurn', () => {
  const user = { type: 'user' as const, text: 'Fix the  build\nplease', images: 0, ts: 1 }
  const turn = (steps: Turn['steps']): Turn => ({ id: '1', user, steps, start: 1, end: 1 })

  test('the sent message with nothing but thinking and notes after it', () => {
    expect(isUnansweredTurn(turn([]), 'Fix the build please')).toBe(true)
    expect(isUnansweredTurn(turn([{ type: 'think', ts: 2 }]), 'Fix the build please')).toBe(true)
  })

  test('not once a reply or a tool call started, nor for another message', () => {
    expect(isUnansweredTurn(turn([{ type: 'text', text: 'ok', ts: 2 }]), 'Fix the build please')).toBe(false)
    const tool = {
      type: 'tool' as const,
      id: 't',
      tool: 'cmd' as const,
      op: 'run' as const,
      detail: 'ls',
      status: 'running' as const,
      ts: 2,
    }
    expect(isUnansweredTurn(turn([tool]), 'Fix the build please')).toBe(false)
    expect(isUnansweredTurn(turn([]), 'Something else')).toBe(false)
    expect(isUnansweredTurn(turn([]), '')).toBe(false)
    expect(isUnansweredTurn(null, 'Fix the build please')).toBe(false)
    expect(isUnansweredTurn({ ...turn([]), user: null }, 'Fix the build please')).toBe(false)
  })
})
