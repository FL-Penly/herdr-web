import { describe, expect, test } from 'bun:test'
import {
  collectPrompt,
  hasInputBox,
  hasMainPromptHint,
  inputDraft,
  inputLines,
  isAsyncPanelOpen,
  lastUserEcho,
  lines,
  sameText,
  stripAnsi,
} from '../../src/tui/screen.ts'
import { claudeBox, screen } from './fixtures.ts'

describe('inputLines', () => {
  test('Claude: restored multi-row prompt (❯ is followed by NBSP)', () => {
    expect(inputLines(screen('claude-idle-restored'))).toEqual([
      'please refactor the dialog parser so it only',
      'looks at the bottom of the screen',
    ])
  })

  test('Claude: empty box', () => {
    expect(inputLines(screen('claude-busy'))).toEqual([])
  })

  test('Codex: the composer row (its placeholder is plain text too)', () => {
    expect(inputLines(screen('codex-idle'))).toEqual(['Ask Codex to do anything'])
    const typed = ['› fix the parser', '  and add tests', '', '  gpt · Context 90% left'].join('\n')
    expect(inputLines(typed)).toEqual(['fix the parser', 'and add tests'])
  })

  test('no input box while a dialog is open', () => {
    expect(inputLines(screen('claude-permission'))).toEqual([])
    expect(inputLines(screen('claude-model-menu'))).toEqual([])
  })
})

describe('hasInputBox', () => {
  test('a Claude prompt row needs its rules', () => {
    expect(hasInputBox('❯\u00a0hello')).toBe(false)
    expect(hasInputBox(claudeBox(['hello']))).toBe(true)
  })

  test('dialogs hide the box', () => {
    expect(hasInputBox(screen('claude-trust'))).toBe(false)
    expect(hasInputBox(screen('codex-approval'))).toBe(false)
  })
})

describe('collectPrompt', () => {
  test('stops at the second blank gap, a rule or a bullet; skips dashed separators', () => {
    const rows = lines(['⏺ earlier', 'a', '', 'b', '╌╌╌╌', 'c', '', 'X'].join('\n'))
    expect(collectPrompt(rows, 7, 10)).toBe('a\nb\nc')
    expect(collectPrompt(lines(`${'─'.repeat(10)}\nq\nX`), 2, 10)).toBe('q')
    expect(collectPrompt(lines('one\ntwo\nthree\nX'), 3, 2)).toBe('two\nthree')
  })
})

describe('Codex panel hints', () => {
  test('async panel open / main prompt hint', () => {
    expect(isAsyncPanelOpen(screen('codex-async-panel'))).toBe(true)
    expect(hasMainPromptHint(screen('codex-async-panel'))).toBe(true)
    expect(isAsyncPanelOpen(screen('codex-async-pending'))).toBe(false)
  })
})

describe('lastUserEcho', () => {
  test('the newest sent message above the Codex input box, with its wrapped rows', () => {
    expect(lastUserEcho(screen('codex-resumed'))).toBe('Count the lines in n.txt and tell me how\nmany there are')
  })

  test('null without an echo or an input box', () => {
    expect(lastUserEcho(screen('codex-idle'))).toBeNull()
    expect(lastUserEcho(screen('codex-trust'))).toBeNull()
  })
})

describe('sameText', () => {
  test('ignores wrapping and frames, nothing else', () => {
    expect(
      sameText('Reason: x\n$ bun run migrate --env staging', '│ Reason: x $ bun run\n│ migrate --env staging │'),
    ).toBe(true)
    expect(sameText('$ bun run migrate --env staging', '$ bun run migrate --env production')).toBe(false)
    expect(sameText('Continue', 'Continue with deployment')).toBe(false)
  })

  test('a trailing ellipsis matches only text that goes on from what it shows', () => {
    expect(sameText('$ bun run migrate --e…', '$ bun run migrate --env production')).toBe(true)
    expect(sameText('$ bun run migrate --env production', '$ bun run mig…')).toBe(true)
    expect(sameText('$ bun run migrate --env s…', '$ bun run migrate --env p…')).toBe(false)
    expect(sameText('$ bun run migrate --env s…', '$ bun run migrate --env production')).toBe(false)
    expect(sameText('…', 'anything')).toBe(false)
    expect(sameText('rm …/a', 'rm /b/a')).toBe(false)
  })
})

describe('inputDraft', () => {
  // Real `herdr pane read --ansi` captures: both TUIs draw their placeholder dim and typed text plain.
  test('a placeholder is not a draft, for either agent', () => {
    expect(stripAnsi(screen('ansi/claude-placeholder'))).toContain('Try "refactor <filepath>"')
    expect(inputDraft(screen('ansi/claude-placeholder'))).toBe('')
    expect(stripAnsi(screen('ansi/codex-placeholder'))).toContain('Ask Codex to do anything')
    expect(inputDraft(screen('ansi/codex-placeholder'))).toBe('')
  })

  test('text typed in the terminal and not sent, all of its rows, wherever its cursor is', () => {
    // Both were typed, then the cursor moved five places left, into the middle of the last row.
    expect(inputDraft(screen('ansi/claude-draft'))).toBe('fix the parser\nand R5LEFT__RIGHT')
    expect(inputDraft(screen('ansi/codex-draft'))).toBe('run the tests\nthen R5LEFT__RIGHT')
  })

  test('plain screens, an empty box, no box', () => {
    expect(inputDraft(claudeBox(['half a thought'], ['  ? for shortcuts']))).toBe('half a thought')
    expect(inputDraft(claudeBox([], ['  ? for shortcuts']))).toBe('')
    expect(inputDraft(screen('claude-permission'))).toBe('')
  })

  test('SGR parameters are read as attributes, not the numbers inside a color', () => {
    const rule = '─'.repeat(40)
    // 38;2;2;… is a color whose red is 2, not dim; 22 ends dim.
    const row = '❯\u00a0\x1b[38;2;2;2;2mtyped\x1b[0m \x1b[2mhint\x1b[22m more\r'
    expect(inputDraft([rule, row, rule, '  ? for shortcuts'].join('\n'))).toBe('typed  more')
    // Codex's braille animation can cross the input row.
    expect(inputDraft(['› \x1b[2mAsk Codex to do anything\x1b[0m⡀  ⠈', '', '  gpt · 100% left'].join('\n'))).toBe('')
  })
})
