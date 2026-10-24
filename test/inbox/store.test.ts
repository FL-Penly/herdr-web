import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InboxStore, PRUNE_GRACE_MS } from '../../src/inbox/store.ts'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-web-inbox-'))
  path = join(dir, 'nested', 'state.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const T = 1_800_000_000_000

describe('InboxStore', () => {
  test('since restarts when the status key changes', () => {
    const s = new InboxStore(path)
    expect(s.observe('p1', 'claude:a', 'working:0', T)).toEqual({ since: T, firstSeen: true })
    expect(s.observe('p1', 'claude:a', 'working:0', T + 10)).toEqual({ since: T, firstSeen: false })
    expect(s.observe('p1', 'claude:a', 'done:1', T + 20)).toEqual({ since: T + 20, firstSeen: false })
    s.setSince('p1', T + 5)
    expect(s.observe('p1', 'claude:a', 'done:1', T + 30).since).toBe(T + 5)
  })

  test('ack, unack, snooze; persisted atomically', () => {
    const s = new InboxStore(path)
    s.observe('p1', 'claude:a', 'done:1', T)
    s.ack('p1', 'f:1')
    expect(s.isAcked('p1', 'f:1')).toBe(true)
    expect(s.isAcked('p1', 'f:2')).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json'])
    expect(new InboxStore(path).isAcked('p1', 'f:1')).toBe(true)

    s.snooze('p1', 'f:1', T + 1000)
    expect(s.snoozedUntil('p1', 'f:1', T)).toBe(T + 1000)
    expect(s.snoozedUntil('p1', 'f:1', T + 1000)).toBeNull()
    expect(s.snoozedUntil('p1', 'f:2', T)).toBeNull()

    s.unack('p1')
    expect(s.isAcked('p1', 'f:1')).toBe(false)
    expect(s.snoozedUntil('p1', 'f:1', T)).toBeNull()
  })

  test('a state.json without owners loads', () => {
    const old = { since: { p1: { key: 'done:3', at: T } }, acked: { p1: 'f:3' }, snoozed: {} }
    mkdirSync(join(dir, 'nested'))
    writeFileSync(path, JSON.stringify(old))
    const s = new InboxStore(path)
    expect(s.isAcked('p1', 'f:3')).toBe(true)
    expect(s.observe('p1', 'claude:a', 'done:3', T + 1)).toEqual({ since: T, firstSeen: false })
    expect(s.isAcked('p1', 'f:3')).toBe(true)
  })

  test('a corrupt state.json warns and starts empty', () => {
    mkdirSync(join(dir, 'nested'))
    writeFileSync(path, '{"since": {"p1": ')
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const s = new InboxStore(path)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    s.ack('p1', 'f:1')
    expect(JSON.parse(readFileSync(path, 'utf8')).acked).toEqual({ p1: 'f:1' })
  })

  test('pruning waits for the grace period and survives an empty snapshot', () => {
    const s = new InboxStore(path)
    s.observe('p1', 'claude:a', 'done:1', T)
    s.ack('p1', 'f:1')
    expect(s.prune(new Set(), T + 1000)).toEqual([])
    expect(s.prune(new Set(), T + PRUNE_GRACE_MS)).toEqual([])
    expect(s.isAcked('p1', 'f:1')).toBe(true)
    const back = T + PRUNE_GRACE_MS + 1
    s.observe('p1', 'claude:a', 'done:1', back)
    expect(s.prune(new Set(['p1']), back)).toEqual([])
    expect(s.prune(new Set(), back + PRUNE_GRACE_MS)).toEqual([])
    expect(s.prune(new Set(), back + PRUNE_GRACE_MS + 1)).toEqual(['p1'])
    expect(s.isAcked('p1', 'f:1')).toBe(false)
  })

  test('entries loaded from disk get a grace period too', () => {
    new InboxStore(path).ack('gone', 'f:1')
    const s = new InboxStore(path)
    expect(s.prune(new Set(), T)).toEqual([])
    expect(s.prune(new Set(), T + PRUNE_GRACE_MS + 1)).toEqual(['gone'])
  })

  test('a reused pane id does not inherit another agent’s acks', () => {
    const s = new InboxStore(path)
    s.observe('p1', 'claude:a', 'done:0', T)
    s.ack('p1', 'f:0')
    s.observe('p1', 'claude:', 'done:0', T + 1)
    expect(s.isAcked('p1', 'f:0')).toBe(true)
    s.observe('p1', 'codex:', 'done:0', T + 2)
    expect(s.isAcked('p1', 'f:0')).toBe(false)
    s.ack('p1', 'f:0')
    s.observe('p1', 'codex:x', 'done:0', T + 3)
    s.observe('p1', 'codex:y', 'done:0', T + 4)
    expect(s.isAcked('p1', 'f:0')).toBe(false)
  })
})
