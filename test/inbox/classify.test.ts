import { describe, expect, test } from 'bun:test'
import { type ClassifyInput, QUESTION_WINDOW_MS, classify, endsWithQuestion } from '../../src/inbox/classify.ts'
import { parseDialog, parseMenu } from '../../src/tui/index.ts'
import { screen } from '../tui/fixtures.ts'

const NOW = 1_800_000_000_000

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return {
    status: 'idle',
    asks: 0,
    menu: null,
    dialog: null,
    reply: null,
    cwd: '/home/alice/project',
    acked: false,
    snoozedUntil: null,
    now: NOW,
    ...over,
  }
}

const reply = (text: string, at = NOW - 1000) => ({ text, at, source: 'transcript' as const })

describe('classify', () => {
  test('permission dialog', () => {
    const e = classify(input({ status: 'blocked', dialog: parseDialog(screen('claude-permission')) }))
    expect(e).toMatchObject({ reason: 'permission', source: 'dialog', question: expect.stringContaining('npm test') })
    expect(e?.options).toHaveLength(3)
    expect(e?.snoozedUntil).toBeNull()
  })

  test('Codex approval is a permission dialog too', () => {
    const e = classify(input({ status: 'blocked', dialog: parseDialog(screen('codex-approval')) }))
    expect(e).toMatchObject({ reason: 'permission', source: 'dialog' })
  })

  test('choice dialog (AskUserQuestion)', () => {
    const e = classify(input({ status: 'blocked', dialog: parseDialog(screen('claude-ask-user-question')) }))
    expect(e).toMatchObject({ reason: 'choice', source: 'dialog' })
  })

  test('a dialog of several questions carries where in it the user is', () => {
    const e = classify(input({ status: 'blocked', dialog: parseDialog(screen('claude-ask-form-review')) }))
    expect(e).toMatchObject({ reason: 'choice', source: 'dialog' })
    expect(e?.form?.review).toEqual([
      { question: 'Favorite color?', answer: 'Red' },
      { question: 'Favorite fruit?', answer: 'Pear' },
    ])
  })

  test('trust dialog: structured, with the folder', () => {
    const e = classify(input({ status: 'blocked', dialog: parseDialog(screen('claude-trust')) }))
    expect(e).toMatchObject({ reason: 'trust', source: 'dialog', folder: '/home/alice/project' })
    expect(e?.question).toContain('read, edit, and execute files here')
    expect(e?.options.map(o => o.key)).toEqual(['1', '2'])
  })

  test('trust dialog without a printed folder falls back to the cwd', () => {
    const dialog = { question: '', options: [], trust: true, folder: null }
    expect(classify(input({ status: 'blocked', dialog, cwd: '/srv/app' }))?.folder).toBe('/srv/app')
  })

  test('blocked without options', () => {
    const dialog = { question: 'Something is waiting', options: [], trust: false, folder: null }
    expect(classify(input({ status: 'blocked', dialog }))).toMatchObject({
      reason: 'blocked',
      source: 'dialog',
      question: 'Something is waiting',
    })
  })

  test('blocked on Codex async questions', () => {
    const dialog = { question: '', options: [], trust: false, folder: null }
    expect(classify(input({ status: 'blocked', dialog, asks: 2 }))).toMatchObject({
      reason: 'question',
      source: 'asks',
      asks: 2,
    })
  })

  test('working with queued questions; acks do not hide them', () => {
    expect(classify(input({ status: 'working', asks: 1, acked: true }))).toMatchObject({
      reason: 'question',
      source: 'asks',
      asks: 1,
    })
    expect(classify(input({ status: 'working' }))).toBeNull()
    expect(classify(input({ status: 'unknown', reply: reply('Ok?') }))).toBeNull()
  })

  test('menu the user opened beats everything while idle, and cannot be acked', () => {
    const menu = parseMenu(screen('claude-model-menu'))
    const e = classify(input({ status: 'idle', menu, acked: true, reply: reply('Want me to continue?') }))
    expect(e).toMatchObject({ reason: 'choice', source: 'menu', question: expect.stringContaining('Select model') })
    expect(e?.options).toHaveLength(3)
  })

  test('panel', () => {
    const e = classify(input({ status: 'done', menu: parseMenu(screen('claude-status-panel')) }))
    expect(e).toMatchObject({ reason: 'blocked', source: 'panel', options: [] })
    expect(e?.question).toContain('Version: 2.1.0')
  })

  test('done: the last reply, a question when it ends like one', () => {
    expect(classify(input({ status: 'done', reply: reply('All tests pass.') }))).toMatchObject({
      reason: 'done',
      source: 'transcript',
      message: 'All tests pass.',
    })
    expect(classify(input({ status: 'done', reply: reply('Should I also update the docs?') }))?.reason).toBe('question')
  })

  test('done with only the screen to go on', () => {
    const e = classify(input({ status: 'done', reply: { text: 'Finished.', at: 0, source: 'screen' } }))
    expect(e).toMatchObject({ reason: 'done', source: 'screen', message: 'Finished.' })
    expect(classify(input({ status: 'done' }))).toMatchObject({ reason: 'done', message: '' })
  })

  test('idle: only a recent question counts', () => {
    expect(classify(input({ reply: reply('Want me to push?') }))?.reason).toBe('question')
    expect(classify(input({ reply: reply('Want me to push?', NOW - QUESTION_WINDOW_MS - 1) }))).toBeNull()
    expect(classify(input({ reply: { text: 'Push now?', at: 0, source: 'screen' } }))?.reason).toBe('question')
    expect(classify(input({ reply: reply('Pushed.') }))).toBeNull()
  })

  test('acked and snoozed', () => {
    expect(classify(input({ status: 'done', reply: reply('Done.'), acked: true }))).toBeNull()
    const dialog = parseDialog(screen('claude-permission'))
    expect(classify(input({ status: 'blocked', dialog, acked: true }))).toBeNull()
    expect(classify(input({ status: 'done', reply: reply('Done.'), snoozedUntil: NOW + 5 }))?.snoozedUntil).toBe(
      NOW + 5,
    )
  })
})

describe('endsWithQuestion', () => {
  test.each([
    ['Shall we ship it?', true],
    ['要部署吗？**', true],
    ['Which option do you prefer (A or B?)', true],
    ['Pick one (A or B?）', true],
    ['Want me to open a PR', true],
    ['要不要我顺便更新文档', true],
    ['Done.\n\nAnything else?\n', true],
    ['Tests pass, should I merge', true],
    ['改好了，要不要我顺便更新文档', true],
    ['这样改可以吗', true],
    ['Is it fixed? Yes.', false],
    ['Fixed the bug which caused the crash.', false],
    ['Done. Which tests run is controlled by CI.', false],
    ['已确认是否需要迁移：不需要。', false],
    ['I did what you want me to do', false],
    ['All tests pass.', false],
    ['', false],
  ])('%p → %p', (text, expected) => {
    expect(endsWithQuestion(text)).toBe(expected)
  })
})
