import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlTail } from '../../src/lib/jsonl.ts'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jsonl-'))
  file = join(dir, 'log.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const line = (v: unknown) => `${JSON.stringify(v)}\n`

describe('JsonlTail', () => {
  test('missing file reads as empty', () => {
    expect(new JsonlTail(file).read()).toEqual({ rows: [], reset: false })
  })

  test('yields rows with exact byte offsets', () => {
    const a = line({ text: '中文' })
    const b = line({ n: 2 })
    writeFileSync(file, a + b)
    const { rows } = new JsonlTail(file).read()
    const bytes = readFileSync(file)
    expect(rows.map(r => r.row)).toEqual([{ text: '中文' }, { n: 2 }])
    expect(rows[0]).toMatchObject({ start: 0, end: Buffer.byteLength(a) })
    expect(rows[1]).toMatchObject({ start: Buffer.byteLength(a), end: bytes.length })
    expect(bytes.subarray(rows[1]!.start, rows[1]!.end).toString()).toBe(b)
  })

  test('a multibyte character split across two reads decodes intact', () => {
    const full = Buffer.from(line({ text: '你好，世界' }))
    const cut = full.indexOf(Buffer.from('好')) + 1
    writeFileSync(file, full.subarray(0, cut))
    const tail = new JsonlTail(file)
    expect(tail.read().rows).toEqual([])
    expect(tail.offset).toBe(0)
    appendFileSync(file, full.subarray(cut))
    const { rows } = tail.read()
    expect(rows).toEqual([{ row: { text: '你好，世界' }, start: 0, end: full.length }])
    expect(tail.offset).toBe(full.length)
  })

  test('an unterminated last line waits for its newline', () => {
    writeFileSync(file, `${line({ a: 1 })}{"b":`)
    const tail = new JsonlTail(file)
    expect(tail.read().rows.map(r => r.row)).toEqual([{ a: 1 }])
    appendFileSync(file, '2}\n')
    const { rows } = tail.read()
    expect(rows.map(r => r.row)).toEqual([{ b: 2 }])
    expect(rows[0]!.end).toBe(readFileSync(file).length)
  })

  test('skips non-JSON lines but keeps offsets moving', () => {
    writeFileSync(file, `not json\n{broken\n${line({ ok: true })}`)
    const { rows } = new JsonlTail(file).read()
    expect(rows).toEqual([{ row: { ok: true }, start: 17, end: 29 }])
  })

  test('truncation resets', () => {
    writeFileSync(file, line({ a: 1 }) + line({ b: 2 }))
    const tail = new JsonlTail(file)
    tail.read()
    truncateSync(file, 0)
    writeFileSync(file, line({ c: 3 }))
    expect(tail.read()).toEqual({ rows: [{ row: { c: 3 }, start: 0, end: 8 }], reset: true })
  })

  test('a replaced file (new inode) resets even when it is larger', () => {
    writeFileSync(file, line({ a: 1 }))
    const tail = new JsonlTail(file)
    tail.read()
    const next = join(dir, 'next.jsonl')
    writeFileSync(next, line({ x: 'replacement' }) + line({ y: 2 }))
    renameSync(next, file)
    const { rows, reset } = tail.read()
    expect(reset).toBe(true)
    expect(rows.map(r => r.row)).toEqual([{ x: 'replacement' }, { y: 2 }])
  })

  test('an in-place rewrite that moves line boundaries resets', () => {
    writeFileSync(file, line({ a: 1 }))
    const tail = new JsonlTail(file)
    tail.read()
    writeFileSync(file, line({ longer: 'row' }))
    expect(tail.read().reset).toBe(true)
  })

  test('limit stops at a byte offset', () => {
    const a = line({ a: 1 })
    writeFileSync(file, a + line({ b: 2 }))
    const tail = new JsonlTail(file, { limit: Buffer.byteLength(a) })
    expect(tail.read().rows.map(r => r.row)).toEqual([{ a: 1 }])
    appendFileSync(file, line({ c: 3 }))
    expect(tail.read().rows).toEqual([])
  })

  test('a tail that starts exactly on a line boundary keeps that line', () => {
    const rows = Array.from({ length: 10 }, (_, i) => line({ i }))
    writeFileSync(file, rows.join(''))
    const lastThree = rows.slice(-3).join('')
    const got = new JsonlTail(file, { maxInitialBytes: Buffer.byteLength(lastThree) }).read().rows
    expect(got.map(r => r.row)).toEqual([{ i: 7 }, { i: 8 }, { i: 9 }])
  })

  test('a large file is tailed from a line boundary', () => {
    const rows = Array.from({ length: 50 }, (_, i) => line({ i, pad: 'x'.repeat(20) }))
    writeFileSync(file, rows.join(''))
    const tail = new JsonlTail(file, { maxInitialBytes: 200 })
    const got = tail.read().rows
    expect(tail.skipped).toBe(true)
    expect(new JsonlTail(file).skipped).toBe(false)
    expect(got.length).toBeGreaterThan(0)
    expect(got.at(-1)!.row).toEqual({ i: 49, pad: 'x'.repeat(20) })
    const bytes = readFileSync(file)
    for (const r of got) expect(JSON.parse(bytes.subarray(r.start, r.end).toString())).toEqual(r.row)
  })
})
