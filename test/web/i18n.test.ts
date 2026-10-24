import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import en from '../../public/js/i18n/en.js'
import { type Message, kbd, pickLocale, pluralForm, setLocale, t } from '../../public/js/i18n/index.js'
import zhCN from '../../public/js/i18n/zh-CN.js'
import { inboxSummary, noteText, toolLabel } from '../../public/js/labels.js'
import type { InboxReason, ToolItem } from '../../src/protocol.ts'

const PUBLIC = join(import.meta.dir, '../../public')
const sources = readdirSync(join(PUBLIC, 'js'))
  .filter(f => f.endsWith('.js'))
  .map(f => readFileSync(join(PUBLIC, 'js', f), 'utf8'))
  .join('\n')
const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8')

describe('locale tables', () => {
  test('zh-CN and en define exactly the same keys', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
  })

  test('placeholders match between locales and plural forms', () => {
    const forms = (m: Message): string[] => (typeof m === 'string' ? [m] : Object.values(m))
    const vars = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort()
    for (const key of Object.keys(en)) {
      const want = vars(forms(en[key])[0] ?? '')
      for (const text of [...forms(en[key]), ...forms(zhCN[key])]) expect([key, vars(text)]).toEqual([key, want])
    }
  })

  test('plural messages count with {n} and always have an `other` form', () => {
    for (const [key, m] of Object.entries({ ...en, ...zhCN })) {
      if (typeof m === 'string') continue
      expect([key, typeof m.other]).toEqual([key, 'string'])
      expect([key, m.other.includes('{n}')]).toEqual([key, true])
    }
  })

  test('no English message spells a plural as (s)', () => {
    const texts = Object.values(en).flatMap(m => (typeof m === 'string' ? [m] : Object.values(m)))
    expect(texts.filter(text => /\w\(s\)/.test(text))).toEqual([])
  })

  test('every literal key used in the code exists', () => {
    const used = [...sources.matchAll(/\bt\('([\w.-]+)'/g)].map(m => m[1])
    expect(used.length).toBeGreaterThan(100)
    expect(used.filter(key => !(key in en))).toEqual([])
  })

  test('every key referenced by index.html exists', () => {
    const used = [...html.matchAll(/data-i18n(?:-[\w-]+)?="([\w.-]+)"/g)].map(m => m[1])
    expect(used.length).toBeGreaterThan(20)
    expect(used.filter(key => !(key in en))).toEqual([])
  })

  test('every shortcut label exists', () => {
    const labels = [...sources.matchAll(/label: '(shortcuts\.[\w]+)'/g)].map(m => m[1])
    expect(labels.length).toBeGreaterThan(5)
    expect(labels.filter(key => !(key in en))).toEqual([])
  })

  test('dynamic key families are complete', () => {
    const reasons: InboxReason[] = ['permission', 'trust', 'choice', 'blocked', 'question', 'done']
    for (const reason of reasons) expect(en).toHaveProperty([`inbox.reason.${reason}`])
    for (const mode of ['system', 'light', 'dark']) expect(en).toHaveProperty([`theme.${mode}`])
    for (const source of ['builtin', 'skill', 'command', 'plugin', 'project'])
      expect(en).toHaveProperty([`source.${source}`])
    for (const tool of ['cmd', 'edit', 'read', 'search', 'web', 'task', 'todo', 'plan', 'skill', 'ask', 'other']) {
      expect(en).toHaveProperty([`tool.${tool}`])
    }
  })

  test('built-in command descriptions cover both agents', () => {
    const claude = Object.keys(en).filter(k => k.startsWith('cmd.claude.'))
    const codex = Object.keys(en).filter(k => k.startsWith('cmd.codex.'))
    expect(claude.length).toBeGreaterThan(40)
    expect(codex.length).toBeGreaterThan(25)
  })
})

describe('t', () => {
  test('interpolates and falls back to English, then to the key', () => {
    setLocale('zh-CN')
    expect(t('sidebar.summary', { n: 3, running: 1 })).toBe('3 个会话 · 1 在跑')
    expect(t('no.such.key')).toBe('no.such.key')
    setLocale('en')
    expect(t('sidebar.summary', { n: 3, running: 1 })).toBe('3 sessions · 1 running')
    expect(t('sidebar.newIn', {})).toBe('New session in {name}')
  })

  test('picks the plural form by n', () => {
    setLocale('en')
    expect(t('composer.shells', { n: 1 })).toBe('1 shell')
    expect(t('composer.shells', { n: 3 })).toBe('3 shells')
    expect(t('composer.shells', { n: 0 })).toBe('0 shells')
    expect(t('note.tokens', { n: '12K' })).toBe('12K tokens')
    expect(t('note.tokens', { n: '1' })).toBe('1 token')
    expect(t('composer.shells')).toBe('{n} shells')
    setLocale('zh-CN')
    expect(t('composer.shells', { n: 1 })).toBe('1 个 shell')
    setLocale('en')
  })

  test('pluralForm falls back to other', () => {
    expect(pluralForm({ other: 'x' }, 'en', 1)).toBe('x')
    expect(pluralForm({ one: 'a', other: 'b' }, 'en', Number.NaN)).toBe('b')
    expect(pluralForm({ one: 'a', few: 'c', other: 'b' }, 'ru', 3)).toBe('c')
  })
})

describe('pickLocale', () => {
  test('explicit choice, then browser languages, then English', () => {
    expect(pickLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(pickLocale('fr', ['zh-TW', 'en'])).toBe('zh-CN')
    expect(pickLocale(null, ['de-DE', 'en-GB'])).toBe('en')
    expect(pickLocale(null, ['de-DE'])).toBe('en')
  })
})

describe('kbd', () => {
  test('platform-aware modifier names', () => {
    expect(kbd('mod+K', true)).toBe('⌘K')
    expect(kbd('mod+K', false)).toBe('Ctrl+K')
    expect(kbd('alt+N', true)).toBe('⌥N')
    expect(kbd('alt+N', false)).toBe('Alt+N')
  })
})

describe('labels', () => {
  const tool = (over: Partial<ToolItem>): ToolItem => ({
    type: 'tool',
    id: '1',
    tool: 'cmd',
    op: 'run',
    detail: '',
    status: 'ok',
    ts: 0,
    ...over,
  })

  test('tool labels by kind and op, raw names for other tools', () => {
    setLocale('en')
    expect(toolLabel(tool({}))).toBe('Run')
    expect(toolLabel(tool({ tool: 'read', op: 'image' }))).toBe('View image')
    expect(toolLabel(tool({ tool: 'edit', op: 'call' }))).toBe('Edit')
    expect(toolLabel(tool({ tool: 'other', op: 'call', name: 'github · create_issue' }))).toBe('github · create_issue')
    setLocale('zh-CN')
    expect(toolLabel(tool({ tool: 'web', op: 'fetch' }))).toBe('打开网页')
    setLocale('en')
  })

  test('goal notes', () => {
    setLocale('en')
    const complete = noteText({
      type: 'note',
      code: 'goal.complete',
      text: 'All tests pass',
      goal: { text: 'ship', status: 'complete', secs: 65, turns: 3, tokens: 12_000 },
      ts: 0,
    })
    expect(complete).toEqual({ text: 'Goal complete · 1m 5s · 3 turns · 12K tokens\nAll tests pass', tone: 'ok' })
    expect(noteText({ type: 'note', code: 'goal.paused', ts: 0 }).text).toBe('Goal paused')
    expect(noteText({ type: 'note', code: 'goal.status', text: 'budget', ts: 0 }).text).toBe('Goal: budget')
    expect(noteText({ type: 'note', code: 'command', text: 'out', ts: 0 })).toEqual({ text: 'out', tone: 'output' })
  })

  test('inbox summaries', () => {
    setLocale('en')
    const base = { question: '', options: [], message: '', snoozedUntil: null }
    expect(inboxSummary({ ...base, reason: 'question', source: 'asks', asks: 2 })).toContain('2 question')
    expect(inboxSummary({ ...base, reason: 'trust', source: 'dialog', folder: '/x' })).toBe(t('inbox.trust.title'))
    expect(inboxSummary({ ...base, reason: 'done', source: 'transcript', message: 'line one\n  line two' })).toBe(
      'line one line two',
    )
  })
})
