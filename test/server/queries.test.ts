import { expect, test } from 'bun:test'
import type { Thread } from '../../src/protocol.ts'
import { liveReply } from '../../src/server/queries.ts'
import { screen } from '../tui/fixtures.ts'

const thread = (texts: string[]): Thread =>
  ({
    turns: [{ id: 't', user: null, start: 0, end: 0, steps: texts.map(text => ({ type: 'text', text, ts: 0 })) }],
    more: 0,
    meta: {},
  }) as unknown as Thread

test('the reply on screen is live until the newest turn has it', () => {
  const s = screen('codex-live-table')
  const live = liveReply('codex', s, thread(['I’ll read README.md once, then write the requested paragraph.']), 42)
  expect(live?.at).toBe(42)
  expect(live?.text.startsWith('The project README contains only the heading probe.')).toBe(true)
  const done = `The project README contains only the heading **probe**. Here are 30 English words with their Chinese translations.\n\n| # | word | 中文 |\n|---|---|---|\n${['probe | 探针；探查', 'project | 项目', 'file | 文件', 'folder | 文件夹', 'heading | 标题', 'document | 文档', 'code | 代码'].map((r, i) => `| ${i + 1} | ${r} |`).join('\n')}`
  expect(liveReply('codex', s, thread([done]), 42)).toBeNull()
  expect(liveReply('codex', screen('codex-live-tools'), thread([]), 42)).toBeNull()
})
