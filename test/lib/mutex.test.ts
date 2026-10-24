import { expect, test } from 'bun:test'
import { KeyedMutex } from '../../src/lib/mutex.ts'

test('runs calls with one key in order, one at a time; other keys do not wait', async () => {
  const locks = new KeyedMutex()
  const log: string[] = []
  const step = (name: string, ms: number) => async () => {
    log.push(`${name}:start`)
    await Bun.sleep(ms)
    log.push(`${name}:end`)
    return name
  }
  const results = await Promise.all([
    locks.run('a', step('a1', 20)),
    locks.run('a', step('a2', 1)),
    locks.run('b', step('b1', 1)),
  ])
  expect(results).toEqual(['a1', 'a2', 'b1'])
  expect(log.indexOf('a1:end')).toBeLessThan(log.indexOf('a2:start'))
  expect(log.indexOf('b1:end')).toBeLessThan(log.indexOf('a1:end'))
})

test('a failure is passed to its caller and does not block the next call', async () => {
  const locks = new KeyedMutex()
  const failed = locks.run('a', async () => {
    throw new Error('boom')
  })
  await expect(failed).rejects.toThrow('boom')
  expect(await locks.run('a', async () => 'next')).toBe('next')
})

test('busy until the last queued call has finished', async () => {
  const locks = new KeyedMutex()
  expect(locks.busy('a')).toBe(false)
  const done = locks.run('a', () => Bun.sleep(5))
  expect(locks.busy('a')).toBe(true)
  await done
  expect(locks.busy('a')).toBe(false)
})
