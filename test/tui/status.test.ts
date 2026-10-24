import { describe, expect, test } from 'bun:test'
import { parseStatus } from '../../src/tui/status.ts'
import { claudeBox, screen } from './fixtures.ts'

describe('parseStatus', () => {
  test('Claude busy: activity, ctx, mode, effort with ultracode, model', () => {
    expect(parseStatus(screen('claude-busy'))).toEqual({
      activity: 'Cogitating… (42s · ↓ 3.1k tokens · esc to interrupt)',
      ctx: 19,
      mode: 'bypass permissions',
      effort: 'medium',
      ultra: true,
      model: 'Opus 5.5 (1M context)',
      asks: 0,
      shells: 0,
      inputBox: true,
    })
  })

  test('Claude done with a background shell: counted from the footer, not from the transcript', () => {
    const s = parseStatus(screen('claude-background-shell'))
    expect(s).toMatchObject({ shells: 1, ctx: 33, mode: 'bypass permissions', activity: null })
    expect(parseStatus(claudeBox([], ['  ⏵⏵ accept edits on · 3 shells']))).toMatchObject({ shells: 3 })
    expect(parseStatus(claudeBox([], ['  2 shells']))).toMatchObject({ shells: 2 })
    // "1 shell still running" above the input box is transcript text, and "shells" inside a word is not a count.
    expect(parseStatus(claudeBox(['1 shell still running']))).toMatchObject({ shells: 0 })
    expect(parseStatus(claudeBox([], ['  ⏵⏵ bypass permissions on · 2 shellscripts']))).toMatchObject({ shells: 0 })
  })

  test('Claude idle: accept-edits mode, no activity', () => {
    const s = parseStatus(screen('claude-idle-restored'))
    expect(s.activity).toBeNull()
    expect(s.mode).toBe('accept edits')
    expect(s.ctx).toBe(20)
    expect(s.effort).toBeNull()
    expect(s.ultra).toBeNull()
  })

  test('transcript text that looks like a footer is ignored', () => {
    const s = parseStatus(screen('claude-idle-spoof'))
    expect(s).toMatchObject({ ctx: null, mode: null, effort: null, model: null, asks: 0 })
  })

  test('Codex: Context N% left becomes percent used; YOLO from the header', () => {
    const s = parseStatus(screen('codex-idle'))
    expect(s.ctx).toBe(0)
    expect(s.mode).toBe('YOLO mode')
    expect(parseStatus(screen('codex-menu-spoof'))).toMatchObject({ ctx: 10, inputBox: true })
  })

  test('Codex queued async questions while working', () => {
    const s = parseStatus(screen('codex-async-pending'))
    expect(s.asks).toBe(2)
    expect(s.ctx).toBe(37)
    expect(s.activity).toBe('Working (12s • esc to interrupt)')
  })

  test('asks on a single row', () => {
    const rows = [
      '  ? 1 question · Deploy target · shift+← to answer',
      '',
      '› Ask Codex',
      '',
      '  gpt · Context 50% left',
    ]
    expect(parseStatus(rows.join('\n')).asks).toBe(1)
  })

  test('a dialog hides the footer: chrome fields are null', () => {
    expect(parseStatus(screen('claude-permission'))).toMatchObject({
      ctx: null,
      mode: null,
      model: null,
      inputBox: false,
    })
    expect(parseStatus(screen('codex-approval'))).toMatchObject({ ctx: null, inputBox: false })
  })

  test('modes are normalized', () => {
    const footerWith = (line: string) => claudeBox([], [`  ${line}`])
    expect(parseStatus(footerWith('⏸ plan mode on (shift+tab to cycle)')).mode).toBe('plan mode')
    expect(parseStatus(footerWith('manual mode on')).mode).toBe('manual mode')
    expect(parseStatus(footerWith('auto mode on')).mode).toBe('auto mode')
    const codex = ['› hi', '', '  Plan mode (shift+tab to cycle) · Context 90% left'].join('\n')
    expect(parseStatus(codex).mode).toBe('plan mode')
  })

  test('effort indicator right-aligned above the input box', () => {
    const s = `${' '.repeat(40)}● high · /effort\n${claudeBox([], ['  ⏵⏵ bypass permissions on'])}`
    expect(parseStatus(s)).toMatchObject({ effort: 'high', ultra: false })
    const quoted = `  ● high · /effort\n${claudeBox()}`
    expect(parseStatus(quoted).effort).toBeNull()
  })

  test('effort without ultracode', () => {
    const s = claudeBox([], ['  ◑ high · /effort'])
    expect(parseStatus(s)).toMatchObject({ effort: 'high', ultra: false })
  })

  test('empty screen', () => {
    expect(parseStatus('')).toEqual({
      activity: null,
      ctx: null,
      mode: null,
      effort: null,
      ultra: null,
      model: null,
      asks: 0,
      shells: 0,
      inputBox: false,
    })
  })
})
