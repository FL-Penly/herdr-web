import { describe, expect, test } from 'bun:test'
import { countLines, simpleDiff } from '../../src/agents/transcript.ts'

describe('countLines', () => {
  test('a trailing newline ends the last line', () => {
    expect(countLines('green\n')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\n\n')).toBe(2)
    expect(countLines('')).toBe(0)
    expect(countLines(undefined)).toBe(0)
  })

  test('simpleDiff has no empty line for the final newline', () => {
    expect(simpleDiff('old\n', 'new\n')).toBe('-old\n+new')
    expect(simpleDiff('', 'x\ny\n')).toBe('+x\n+y')
  })
})
