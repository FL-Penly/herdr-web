import { describe, expect, test } from 'bun:test'
import { isReadyForInput, parseDialog } from '../../src/tui/dialog.ts'
import { screen } from './fixtures.ts'

describe('parseDialog', () => {
  test('Claude Bash permission dialog', () => {
    const d = parseDialog(screen('claude-permission'))
    expect(d.question).toBe(
      'rm -rf build && npm test\nRemove the build output and run the test suite\nDo you want to proceed?',
    )
    expect(d.options.map(o => [o.key, o.label, !!o.current])).toEqual([
      ['1', 'Yes', true],
      ['2', "Yes, and don't ask again for npm test commands in /home/alice/project", false],
      ['3', 'No, and tell Claude what to do differently (esc)', false],
    ])
  })

  test('Claude read permission: a label wrapped at the right edge keeps its directory', () => {
    const d = parseDialog(screen('claude-read-permission'))
    expect(d.question.split('\n').at(-1)).toBe('Do you want to proceed?')
    expect(d.question).toContain('Read(/tmp/hw-probe-0000/outside/')
    const dir =
      '/tmp/hw-probe-0000/outside/very-long-directory-name-for-wrapping/another-quite-long-segment/uploads-for-the-review'
    expect(d.options).toEqual([
      { key: '1', label: 'Yes', current: true },
      { key: '2', label: `Yes, allow reading from ${dir} during this session` },
      { key: '3', label: 'No' },
    ])
  })

  test('a label wrapped at a space (the directory too long for the row) joins with a space', () => {
    const dir = `/srv/${'a'.repeat(100)}/uploads`
    const text = screen('claude-read-permission').replace(
      /^ {3}2\. Yes, allow reading from .*\n.*$/m,
      `   2. Yes, allow reading from\n      ${dir} during this session`,
    )
    expect(parseDialog(text).options[1]).toEqual({
      key: '2',
      label: `Yes, allow reading from ${dir} during this session`,
    })
  })

  test("Claude's auto-mode tip under the question is not part of it", () => {
    const tipped = screen('claude-permission').replace(
      ' Do you want to proceed?',
      ' Do you want to proceed?\n Tip: auto mode handles these prompts for you · shift+tab to switch',
    )
    expect(parseDialog(tipped).question).toBe(parseDialog(screen('claude-permission')).question)
  })

  test("Codex's /resume picker asks its title, not the filter row", () => {
    expect(parseDialog(screen('codex-resume-picker')).question).toBe('Resume a previous session')
  })

  test('Claude AskUserQuestion: indented descriptions, Type something, options past a rule', () => {
    const d = parseDialog(screen('claude-ask-user-question'))
    expect(d.question).toBe('☐ Database\nWhich database should the service use?')
    expect(d.options).toEqual([
      { key: '1', label: 'PostgreSQL', current: true, desc: 'Relational, battle-tested, needs a server' },
      { key: '2', label: 'SQLite', desc: 'Embedded file, zero configuration' },
      { key: '3', label: 'Type something.' },
      { key: '4', label: 'Chat about this' },
    ])
  })

  test('Claude AskUserQuestion with several questions: the tab row is progress, not part of the question', () => {
    const d = parseDialog(screen('claude-ask-form-question'))
    expect(d.question).toBe('Favorite color?')
    expect(d.form).toEqual({
      steps: [
        { label: 'Color', done: false },
        { label: 'Fruit', done: false },
      ],
      review: null,
    })
    expect(d.options.map(o => o.label)).toEqual(['Red', 'Blue', 'Type something.', 'Chat about this'])
  })

  test('Claude AskUserQuestion submit tab: the answers chosen are the question, before they reach Claude', () => {
    const d = parseDialog(screen('claude-ask-form-review'))
    expect(d.question).toBe('Favorite color? → Red\nFavorite fruit? → Pear\nReady to submit your answers?')
    expect(d.form).toEqual({
      steps: [
        { label: 'Color', done: true },
        { label: 'Fruit', done: true },
      ],
      review: [
        { question: 'Favorite color?', answer: 'Red' },
        { question: 'Favorite fruit?', answer: 'Pear' },
      ],
    })
    expect(d.options).toEqual([
      { key: '1', label: 'Submit answers', current: true },
      { key: '2', label: 'Cancel' },
    ])
  })

  test('a single AskUserQuestion has no tabs to follow', () => {
    expect(parseDialog(screen('claude-ask-user-question')).form).toBeUndefined()
  })

  test('Codex approval dialog', () => {
    const d = parseDialog(screen('codex-approval'))
    expect(d.question).toBe('Reason: apply the pending schema migration\n$ bun run migrate --env staging')
    expect(d.options).toHaveLength(3)
    expect(d.options[0]).toEqual({ key: '1', label: 'Yes, proceed (y)', current: true })
  })

  test('Codex async-question panel', () => {
    const d = parseDialog(screen('codex-async-panel'))
    expect(d.question).toBe('Question 1/2 · Deploy target\nWhich environment should the release go to?')
    expect(d.options.map(o => o.label)).toEqual(['Staging', 'Production', 'Other'])
    expect(d.options[0]?.current).toBe(true)
  })

  test('Codex async panel above a still-visible composer keeps its options', () => {
    const s = `${screen('codex-async-panel')}\n› \n\n  GPT 6.0 · Context 90% left\n`
    expect(parseDialog(s).options).toHaveLength(3)
  })

  test('arrow-key menu: nav keys relative to the cursor', () => {
    const d = parseDialog(screen('claude-model-menu'))
    expect(d.question).toBe(
      'Select model\nSwitch between Claude models. Applies to this session and future Claude Code sessions.',
    )
    expect(d.options).toEqual([
      { key: 'nav:-1', label: 'Default (recommended)', desc: 'Opus 5.5 with 1M context · Best for complex work' },
      { key: 'nav:0', label: 'Sonnet', desc: 'Sonnet 5.5 · Best for everyday tasks', current: true },
      { key: 'nav:1', label: 'Haiku', desc: 'Haiku 5.5 · Fastest for quick answers' },
    ])
  })

  test('a numbered markdown list above an arrow menu is not taken as options', () => {
    const d = parseDialog(screen('claude-list-above-menu'))
    expect(d.question).toBe('Resume a conversation')
    expect(d.options.map(o => o.key)).toEqual(['nav:0', 'nav:1', 'nav:2'])
    expect(d.options.map(o => o.label)).toEqual([
      'Refactor the TUI parser',
      'Write the README',
      'Fix the flaky upload test',
    ])
  })

  test('a numbered list in the transcript with the input box below is not a dialog', () => {
    expect(parseDialog(screen('claude-idle-spoof')).options).toEqual([])
    expect(parseDialog(screen('claude-busy')).options).toEqual([])
    expect(parseDialog(screen('codex-idle')).options).toEqual([])
  })

  test('a blockquote is not a cursor', () => {
    const d = parseDialog('Pick one\n> 1. first\n  2. second')
    expect(d.options).toEqual([{ key: '2', label: 'second' }])
  })

  test('no dialog: the question falls back to the last rows', () => {
    expect(parseDialog('')).toEqual({ question: '', options: [], trust: false, folder: null })
    expect(parseDialog('a\nb\nc\nd\ne\nf\ng\nh')).toMatchObject({ question: 'c\nd\ne\nf\ng\nh', options: [] })
  })

  test('framed dialogs read like plain ones', () => {
    const s = ['╭────────────╮', '│ Continue?  │', '│ ❯ 1. Yes   │', '│   2. No    │', '╰────────────╯'].join('\n')
    const d = parseDialog(s)
    expect(d.question).toBe('Continue?')
    expect(d.options.map(o => o.label)).toEqual(['Yes', 'No'])
  })
})

describe('trust dialogs', () => {
  test('Claude: trust, with the folder it prints', () => {
    expect(parseDialog(screen('claude-trust'))).toMatchObject({ trust: true, folder: '/home/alice/project' })
  })

  test('Codex: trust, folder from "You are in <folder>"', () => {
    const d = parseDialog(screen('codex-trust'))
    expect(d).toMatchObject({ trust: true, folder: '/home/alice/project' })
    expect(d.options.map(o => o.label)).toEqual(['Yes, continue', 'No, quit'])
  })

  test('other dialogs are not trust dialogs', () => {
    expect(parseDialog(screen('claude-permission'))).toMatchObject({ trust: false, folder: null })
    expect(parseDialog(screen('codex-approval'))).toMatchObject({ trust: false, folder: null })
  })
})

describe('isReadyForInput', () => {
  test.each([
    ['claude-idle-spoof', true],
    ['claude-idle-restored', true],
    ['codex-idle', true],
    ['claude-permission', false],
    ['claude-trust', false],
    ['codex-trust', false],
    ['claude-model-menu', false],
    ['codex-async-panel', false],
  ])('%s → %p', (name, ready) => {
    expect(isReadyForInput(screen(name))).toBe(ready)
  })

  test('empty screen is not ready', () => {
    expect(isReadyForInput('')).toBe(false)
  })
})
