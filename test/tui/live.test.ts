import { describe, expect, test } from 'bun:test'
import { ELLIPSIS, MAX_LIVE_BYTES, isUnseen, parseLive } from '../../src/tui/live.ts'
import { claudeBox, screen } from './fixtures.ts'

describe('parseLive: Claude Code', () => {
  test('the reply being written, unwrapped into paragraphs, the list kept', () => {
    const live = parseLive('claude', screen('claude-live-text'))
    expect(live?.startsWith('Bridges are among the oldest structures people build. From fallen logs')).toBe(true)
    expect(live).toContain('steel spans over wide bays, they all do the same job')
    expect(live).toContain('must meet.\n1. Beam bridges rest a horizontal deck on supports at each end.\n2. Arch')
    expect(live?.endsWith('That helps keep these structures safe for decades, so')).toBe(true)
    expect(live).not.toContain('●')
    expect(live).not.toContain('alice@devbox')
  })

  test('a reply that started above the screen: a box table becomes markdown, marked as cut', () => {
    const live = parseLive('claude', screen('claude-live-table')) ?? ''
    expect(
      live.startsWith(
        `${ELLIPSIS}\n\n|  |  |  |  |\n| --- | --- | --- | --- |\n| 26 | shirt | 衬衫 | noun; countable |`,
      ),
    ).toBe(true)
    expect(live).toContain('| 40 | together | 一起 | adverb |\n\n- Words 1–10 are common verbs')
    expect(live).not.toMatch(/[│┌├└]/)
  })

  test('nothing while it thinks or runs a tool, or while a dialog replaces the input box', () => {
    expect(parseLive('claude', screen('claude-live-thinking'))).toBeNull()
    expect(parseLive('claude', screen('claude-busy'))).toBeNull()
    expect(parseLive('claude', screen('claude-permission'))).toBeNull()
  })

  test('a header row starts a markdown table; wrapped cells are joined', () => {
    const text = [
      '❯ make a table',
      '',
      '● Here:',
      '',
      '  ┌────┬─────────┐',
      '  │ #  │ word    │',
      '  ├────┼─────────┤',
      '  │ 1  │ long    │',
      '  │    │ cell    │',
      '  └────┴─────────┘',
      '',
      claudeBox(),
    ].join('\n')
    expect(parseLive('claude', text)).toBe('Here:\n\n| # | word |\n| --- | --- |\n| 1 | long cell |')
  })

  test('a very long reply keeps its newest 8 KB', () => {
    const rows = Array.from({ length: 400 }, (_, i) => `  line ${i} ${'x'.repeat(40)}`)
    const text = ['❯ go', '', '● start', ...rows, '', claudeBox()].join('\n')
    const live = parseLive('claude', text) ?? ''
    expect(live.startsWith(`${ELLIPSIS}\n\n`)).toBe(true)
    expect(Buffer.byteLength(live)).toBeLessThanOrEqual(MAX_LIVE_BYTES + 8)
    expect(live).toContain('line 399')
  })
})

describe('parseLive: Codex', () => {
  test('text after the tools, with a header-underlined table', () => {
    const live = parseLive('codex', screen('codex-live-table'))
    expect(live).toBe(
      [
        'The project README contains only the heading probe. Here are 30 English words with their Chinese translations.',
        '',
        '| # | word | 中文 |',
        '| --- | --- | --- |',
        '| 1 | probe | 探针；探查 |',
        '| 2 | project | 项目 |',
        '| 3 | file | 文件 |',
        '| 4 | folder | 文件夹 |',
        '| 5 | heading | 标题 |',
        '| 6 | document | 文档 |',
        '| 7 | code | 代码 |',
      ].join('\n'),
    )
  })

  test('the prompt pinned to the top row: the reply continues from above, columns split by display width', () => {
    const live = parseLive('codex', screen('codex-live-pinned')) ?? ''
    expect(live.startsWith(`${ELLIPSIS}\n\n|  |  |  |  |\n| --- | --- | --- | --- |\n`)).toBe(true)
    expect(live).toContain('| 11 | morning | 早晨 | I exercise every morning. |')
    expect(live).not.toContain('Without using any tools')
  })

  test('nothing while the newest block is a tool call', () => {
    expect(parseLive('codex', screen('codex-live-tools'))).toBeNull()
    expect(parseLive('codex', screen('codex-idle'))).toBeNull()
  })
})

describe('isUnseen', () => {
  test('compares letters and digits only, so rendered markdown matches its source', () => {
    const live = parseLive('codex', screen('codex-live-table')) ?? ''
    const source =
      'The project README contains only the heading `probe`. Here are 30 English words with their Chinese translations.\n\n| # | word | 中文 |\n|---|---|---|\n| 1 | probe | 探针；探查 |\n| 2 | project | 项目 |\n| 3 | file | 文件 |\n| 4 | folder | 文件夹 |\n| 5 | heading | 标题 |\n| 6 | document | 文档 |\n| 7 | code | 代码 |\n| 8 | test | 测试 |'
    expect(isUnseen(live, [source])).toBe(false)
    expect(isUnseen(live, ['something else'])).toBe(true)
    expect(isUnseen(`${ELLIPSIS}`, [])).toBe(false)
  })
})
