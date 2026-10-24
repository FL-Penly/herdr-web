import { describe, expect, test } from 'bun:test'
import { createGate, requestId } from '../../public/js/inflight.js'

describe('createGate', () => {
  test('a second run with the same key while the first is out is dropped', async () => {
    const gate = createGate()
    let calls = 0
    let release = () => {}
    const slow = () => {
      calls++
      return new Promise<string>(r => (release = () => r('pane')))
    }
    const first = gate.run('new', slow)
    // Taken synchronously: the double click lands before the first request has answered.
    expect(gate.busy('new')).toBe(true)
    expect(await gate.run('new', slow)).toBeNull()
    expect(calls).toBe(1)
    release()
    expect(await first).toBe('pane')
    expect(gate.busy('new')).toBe(false)
    expect(await gate.run('new', async () => 'again')).toBe('again')
  })

  test('other keys run alongside, and a failure frees the key', async () => {
    const gate = createGate()
    let release = () => {}
    const held = gate.run('fork:w1:p1', () => new Promise<void>(r => (release = r)))
    expect(await gate.run('fork:w1:p2', async () => 2)).toBe(2)
    release()
    await held
    await expect(
      gate.run('dialog:w1:p1', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(gate.busy('dialog:w1:p1')).toBe(false)
  })
})

test('requestId is unique and fits the server pattern', () => {
  const ids = new Set(Array.from({ length: 100 }, requestId))
  expect(ids.size).toBe(100)
  for (const id of ids) expect(id).toMatch(/^[\w.-]{1,64}$/)
})

test('a held key stays taken after a fast answer, so the same double click cannot answer the next dialog', async () => {
  let wake = () => {}
  const gate = createGate(() => new Promise<void>(r => (wake = r)))
  let calls = 0
  const answer = async () => void calls++
  await gate.run('dialog:w1:p1', answer, 600)
  expect(await gate.run('dialog:w1:p1', answer, 600)).toBeNull()
  expect(calls).toBe(1)
  wake()
  await Promise.resolve()
  await gate.run('dialog:w1:p1', answer, 600)
  expect(calls).toBe(2)
})
