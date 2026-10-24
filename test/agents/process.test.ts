import { describe, expect, test } from 'bun:test'
import { argvHints, parseElapsed, procStatStartTicks } from '../../src/agents/process.ts'

const ID = '01a079fd-9a5f-7810-84e5-aba267c264cb'

describe('argvHints', () => {
  test.each([
    [['codex', 'resume', ID], { resumeId: ID, forkParentId: null }],
    [['node', '/usr/lib/node_modules/codex/bin/codex', 'resume', ID], { resumeId: ID, forkParentId: null }],
    [['codex', 'fork', ID], { resumeId: null, forkParentId: ID }],
    [['codex', 'resume', '--last'], { resumeId: null, forkParentId: null }],
    [['codex', '-m', 'gpt-test'], { resumeId: null, forkParentId: null }],
  ])('%p', (argv, want) => expect(argvHints(argv)).toEqual(want))
})

describe('procStatStartTicks', () => {
  test('reads field 22 even when comm contains spaces and parentheses', () => {
    const rest = 'S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20 21'
    expect(procStatStartTicks(`1234 (codex) ${rest}`)).toBe(987654)
    expect(procStatStartTicks(`1234 (my (weird) proc) name) ${rest}`)).toBe(987654)
    expect(procStatStartTicks('1234 (codex) S 1 2')).toBeNull()
  })
})

describe('parseElapsed', () => {
  test.each([
    ['   05:07\n', 307],
    ['01:02:03', 3723],
    ['2-01:00:00', 176400],
    ['garbage', null],
  ])('%p → %p', (etime, want) => expect(parseElapsed(etime)).toBe(want))
})
