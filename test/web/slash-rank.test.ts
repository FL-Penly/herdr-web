import { describe, expect, test } from 'bun:test'
import { commandPool, commandRank, rankCommands, slashQuery } from '../../public/js/slash-rank.js'
import type { Command } from '../../src/protocol.ts'

const cmd = (name: string, desc = '', type: Command['type'] = 'builtin'): Command => ({
  name,
  desc,
  type,
  origin: type === 'builtin' ? 'builtin' : 'user',
})

describe('slashQuery', () => {
  test('a slash command only at the very start of the message', () => {
    expect(slashQuery('/rev', 'claude')).toEqual({ trigger: '/', query: 'rev', from: 0 })
    expect(slashQuery('/', 'claude')).toEqual({ trigger: '/', query: '', from: 0 })
    expect(slashQuery('/Model', 'codex')).toEqual({ trigger: '/', query: 'model', from: 0 })
    expect(slashQuery('/review now', 'claude')).toBeNull()
    expect(slashQuery('see /review', 'claude')).toBeNull()
  })

  test('Codex $skills anywhere after whitespace', () => {
    expect(slashQuery('use $pla', 'codex')).toEqual({ trigger: '$', query: 'pla', from: 4 })
    expect(slashQuery('$', 'codex')).toEqual({ trigger: '$', query: '', from: 0 })
    expect(slashQuery('price$5', 'codex')).toBeNull()
    expect(slashQuery('use $pla', 'claude')).toBeNull()
  })
})

describe('commandPool', () => {
  const catalog = { commands: [cmd('model')], skills: [cmd('planner', '', 'skill')] }

  test('Codex slash list includes skills marked with $', () => {
    const pool = commandPool('/', 'codex', catalog)
    expect(pool.map(c => c.name)).toEqual(['model', 'planner'])
    expect(pool[1].mark).toBe('$')
    expect(pool[0].mark).toBeUndefined()
  })

  test('$ lists only skills; Claude lists only commands', () => {
    expect(commandPool('$', 'codex', catalog).map(c => c.name)).toEqual(['planner'])
    expect(commandPool('/', 'claude', catalog).map(c => c.name)).toEqual(['model'])
  })
})

describe('commandRank', () => {
  test('prefix < word prefix < substring < description < none', () => {
    expect(commandRank(cmd('review'), 're')).toBe(0)
    expect(commandRank(cmd('security-review'), 're')).toBe(1)
    expect(commandRank(cmd('plugin:deploy'), 'dep')).toBe(1)
    expect(commandRank(cmd('preview'), 'view')).toBe(2)
    expect(commandRank(cmd('ctx', 'Show context usage'), 'usage')).toBe(3)
    expect(commandRank(cmd('ctx', 'Show context'), 'zzz')).toBe(9)
  })
})

describe('rankCommands', () => {
  test('orders by rank then by name length and drops misses', () => {
    const pool = [cmd('security-review'), cmd('review'), cmd('reviewer'), cmd('help', 'review help'), cmd('exit')]
    expect(rankCommands(pool, 'review').map(c => c.name)).toEqual(['review', 'reviewer', 'security-review', 'help'])
  })

  test('empty query lists everything up to the limit, shortest first', () => {
    const pool = ['compact', 'cd', 'clear'].map(n => cmd(n))
    expect(rankCommands(pool, '').map(c => c.name)).toEqual(['cd', 'clear', 'compact'])
    expect(rankCommands(pool, '', 2)).toHaveLength(2)
  })
})
