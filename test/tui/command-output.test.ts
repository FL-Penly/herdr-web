import { describe, expect, test } from 'bun:test'
import { slashCommandOutput } from '../../src/tui/command-output.ts'
import { screen } from './fixtures.ts'

describe('slashCommandOutput', () => {
  test('/context output up to the input box', () => {
    expect(slashCommandOutput(screen('claude-context-output'), '/context')).toBe(
      [
        ' Context Usage',
        '     ⛁ ⛀ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁   claude-opus-5-5[1m] · 45k/1000k tokens (5%)',
        '     ⛁ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System prompt: 3.1k tokens (0.3%)',
        '                            ⛁ Messages: 38k tokens (3.8%)',
      ].join('\n'),
    )
  })

  test('the latest echo of the command wins; arguments are allowed', () => {
    const s = ['> /cost', '  ⎿  Total cost: $0.10', '', '❯ /cost --verbose', '  ⎿  Total cost: $0.42', '❯'].join('\n')
    expect(slashCommandOutput(s, '/cost')).toBe(' Total cost: $0.42')
  })

  test('null until the command printed something', () => {
    expect(slashCommandOutput(screen('claude-context-output'), '/usage')).toBeNull()
    expect(slashCommandOutput('❯ /context\n❯ ', '/context')).toBeNull()
  })

  test('a hint inside the output that names the command is not an echo', () => {
    const s = [
      '❯ /context',
      '  ⎿  Context Usage',
      '     ⛁ Messages: 1k tokens',
      '',
      '     /context all to expand',
      '❯ ',
    ]
    expect(slashCommandOutput(s.join('\n'), '/context')).toBe(
      [' Context Usage', '     ⛁ Messages: 1k tokens', '', '     /context all to expand'].join('\n'),
    )
  })

  test('a spinner after the output is not part of it', () => {
    const s = ['❯ /goal ship it', '  ⎿  Goal set: ship it', '', '✶ Churning…', '', '─'.repeat(20)]
    expect(slashCommandOutput(s.join('\n'), '/goal')).toBe(' Goal set: ship it')
  })

  test('null while the command still shows its spinner', () => {
    const s = [
      '❯ /context',
      '',
      '✢ Prestidigitating…',
      '  Tip: /loop runs any prompt on a recurring schedule',
      '',
      '─'.repeat(20),
    ]
    expect(slashCommandOutput(s.join('\n'), '/context')).toBeNull()
  })
})
