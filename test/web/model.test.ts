import { describe, expect, test } from 'bun:test'
import {
  AGENT_NAME_RE,
  INTERRUPTED_RE,
  SEND_GUARD_MS,
  cardKey,
  catalogEfforts,
  changeLines,
  commandSourceKey,
  currentModel,
  folderLabel,
  groupSteps,
  hasBlockingDialog,
  historyControls,
  homeTarget,
  isAffirmative,
  isFreeTextOption,
  isLongUserText,
  kindShort,
  lastReplyText,
  livePreview,
  modelLabel,
  needList,
  opensInTerminal,
  optionAction,
  optionForDigit,
  optionShortcut,
  pendingChange,
  pickHottest,
  readingAnchor,
  resolveModelPick,
  runCounts,
  sendButtonMode,
  shellsAfterTurn,
  showsDialogCard,
  splitQuestion,
  statusDotClass,
  tabInfo,
  toggleAllGroups,
  turnPrompts,
  usageChip,
} from '../../public/js/model.js'
import type {
  AgentView,
  InboxEntry,
  Item,
  ModelCatalog,
  TabView,
  TerminalView,
  ToolItem,
  Turn,
} from '../../src/protocol.ts'

const inbox = (over: Partial<InboxEntry> = {}): InboxEntry => ({
  reason: 'question',
  source: 'transcript',
  question: '',
  options: [],
  message: '',
  snoozedUntil: null,
  ...over,
})

const agent = (over: Partial<AgentView> = {}): AgentView => ({
  pane: 'w1:p1',
  tab: 'w1:t1',
  workspace: 'w1',
  workspaceLabel: 'project',
  tabLabel: '1',
  kind: 'claude',
  name: null,
  title: '',
  cwd: '/home/alice/project',
  status: 'idle',
  since: 1000,
  branch: null,
  session: null,
  activity: null,
  ctx: null,
  mode: null,
  effort: null,
  ultra: false,
  model: null,
  asks: 0,
  shells: 0,
  inbox: null,
  ...over,
})

describe('needList', () => {
  test('excludes user-opened menus and panels, idle agents and snoozed entries', () => {
    const now = 10_000
    const list = needList(
      [
        agent({ pane: 'a', inbox: inbox({ source: 'menu', reason: 'choice' }) }),
        agent({ pane: 'b', inbox: inbox({ source: 'panel', reason: 'blocked' }) }),
        agent({ pane: 'c' }),
        agent({ pane: 'd', inbox: inbox({ snoozedUntil: now + 1 }) }),
        agent({ pane: 'e', inbox: inbox({ snoozedUntil: now - 1 }) }),
      ],
      now,
    )
    expect(list.map(a => a.pane)).toEqual(['e'])
  })

  test('open questions first, oldest first; finished replies last', () => {
    const list = needList([
      agent({ pane: 'done', since: 1, inbox: inbox({ reason: 'done' }) }),
      agent({ pane: 'late', since: 30, inbox: inbox({ reason: 'permission', source: 'dialog' }) }),
      agent({ pane: 'early', since: 20, inbox: inbox({ reason: 'question' }) }),
    ])
    expect(list.map(a => a.pane)).toEqual(['early', 'late', 'done'])
  })
})

describe('statusDotClass and pickHottest', () => {
  test('dot reflects working, waiting and done', () => {
    expect(statusDotClass(undefined)).toBe('dot')
    expect(statusDotClass(agent({ status: 'working' }))).toBe('dot dot-running')
    expect(statusDotClass(agent({ inbox: inbox({ reason: 'choice' }) }))).toBe('dot dot-needs')
    expect(statusDotClass(agent({ inbox: inbox({ reason: 'done' }) }))).toBe('dot dot-done')
    expect(statusDotClass(agent())).toBe('dot')
  })

  test("the dot follows herdr's status, not what was read here", () => {
    // Read here (acked, no inbox entry): herdr still says done until the pane is focused there, and so does the dot.
    expect(statusDotClass(agent({ status: 'done' }))).toBe('dot dot-done')
    expect(statusDotClass(agent({ status: 'blocked' }))).toBe('dot dot-needs')
    expect(statusDotClass(agent({ status: 'idle' }))).toBe('dot')
    expect(pickHottest([agent({ pane: 'a' }), agent({ pane: 'b', status: 'done' })])?.pane).toBe('b')
  })

  test('background shells: counted after a finished turn only; the dot still says done', () => {
    expect(statusDotClass(agent({ status: 'done', shells: 1, inbox: inbox({ reason: 'done' }) }))).toBe('dot dot-done')
    expect(shellsAfterTurn(agent({ status: 'done', shells: 2 }))).toBe(2)
    expect(shellsAfterTurn(agent({ status: 'working', shells: 1 }))).toBe(0)
    expect(shellsAfterTurn(agent({ status: 'blocked', shells: 1 }))).toBe(0)
    expect(shellsAfterTurn(undefined)).toBe(0)
  })

  test('working beats waiting beats done', () => {
    const done = agent({ pane: 'done', inbox: inbox({ reason: 'done' }) })
    const waiting = agent({ pane: 'waiting', inbox: inbox({ reason: 'question' }) })
    const working = agent({ pane: 'working', status: 'working' })
    expect(pickHottest([done, waiting, working])?.pane).toBe('working')
    expect(pickHottest([done, waiting])?.pane).toBe('waiting')
    expect(pickHottest([done])?.pane).toBe('done')
    expect(pickHottest([agent()])).toBeNull()
  })
})

describe('opensInTerminal', () => {
  test('panel commands show the terminal; ones with output or a card stay in the chat', () => {
    expect(opensInTerminal('claude', '/config')).toBe(true)
    expect(opensInTerminal('claude', '/permissions')).toBe(true)
    expect(opensInTerminal('codex', '/approvals')).toBe(true)
    expect(opensInTerminal('claude', '/context')).toBe(false)
    expect(opensInTerminal('claude', '/model')).toBe(false)
    expect(opensInTerminal('codex', '/config')).toBe(false)
    expect(opensInTerminal(null, '/config')).toBe(false)
  })
})

describe('toggleAllGroups', () => {
  test('collapses every shown group while any is open, else opens them all; hidden ones keep their state', () => {
    const shown = ['w1', 'w2']
    expect([...toggleAllGroups(new Set(['w1', 'w9']), shown)].sort()).toEqual(['w1', 'w2', 'w9'])
    expect([...toggleAllGroups(new Set(['w1', 'w2', 'w9']), shown)]).toEqual(['w9'])
    expect([...toggleAllGroups(new Set(), shown)].sort()).toEqual(['w1', 'w2'])
  })
})

describe('tabInfo', () => {
  const home = '/home/alice'
  const terminals: TerminalView[] = [
    { pane: 'w1:p9', workspace: 'w1', tab: 'w1:t2', cwd: '/home/alice/logs', title: 'alice@box: /home/alice/logs' },
  ]
  const agents = [
    agent({ pane: 'w1:p1', title: 'Fix login bug' }),
    agent({ pane: 'w1:p2', kind: 'codex', status: 'working' }),
  ]
  const lookup = {
    agentBy: (pane: string) => agents.find(a => a.pane === pane),
    terminalBy: (pane: string) => terminals.find(x => x.pane === pane),
    home,
  }
  const tab = (over: Partial<TabView>): TabView => ({
    id: 't',
    workspace: 'w1',
    label: '1',
    number: 1,
    panes: [],
    ...over,
  })

  test('default labels show the main agent title', () => {
    const info = tabInfo(tab({ label: 'claude', panes: ['w1:p1'] }), lookup)
    expect(info).toEqual({ main: 'w1:p1', name: 'Fix login bug', agent: agents[0] })
  })

  test('user-named tabs keep their name; the busiest agent drives the status', () => {
    const info = tabInfo(tab({ label: 'backend', panes: ['w1:p9', 'w1:p1', 'w1:p2'] }), lookup)
    expect(info.main).toBe('w1:p1')
    expect(info.name).toBe('backend')
    expect(info.agent?.pane).toBe('w1:p2')
  })

  test('agent without a title falls back to its kind; shells to their path', () => {
    expect(tabInfo(tab({ label: '3', panes: ['w1:p2'] }), lookup).name).toBe('Codex')
    const shell = tabInfo(tab({ label: 'shell', panes: ['w1:p9'] }), lookup)
    expect(shell).toEqual({ main: 'w1:p9', name: '~/logs', agent: null })
  })
})

describe('dialog helpers', () => {
  test('free-text and affirmative labels', () => {
    expect(isFreeTextOption('Other')).toBe(true)
    expect(isFreeTextOption('Type something.')).toBe(true)
    expect(isFreeTextOption('其他')).toBe(true)
    expect(isFreeTextOption('Yes')).toBe(false)
    expect(isAffirmative('Yes, and don’t ask again')).toBe(true)
    expect(isAffirmative('Allow once')).toBe(true)
    expect(isAffirmative('No')).toBe(false)
  })

  test('option shortcuts: numbered keys keep their digit, nav options use their position', () => {
    expect(optionShortcut({ key: '3', label: 'x' }, 0)).toBe('3')
    expect(optionShortcut({ key: 'nav:1', label: 'x' }, 1)).toBe('2')
  })

  test('digit to option', () => {
    const numbered = [
      { key: '1', label: 'Yes' },
      { key: '2', label: 'No' },
    ]
    expect(optionForDigit(numbered, '2')?.label).toBe('No')
    expect(optionForDigit(numbered, '3')).toBeNull()
    const nav = [
      { key: 'nav:0', label: 'A' },
      { key: 'nav:1', label: 'B' },
    ]
    expect(optionForDigit(nav, '2')?.label).toBe('B')
    expect(optionForDigit(nav, '5')).toBeNull()
    expect(optionForDigit([], '1')).toBeNull()
  })

  test('dialog card shows for dialogs, menus and panels but not for an option-less Codex ask panel', () => {
    const dialog = agent({
      status: 'blocked',
      inbox: inbox({ reason: 'permission', source: 'dialog', options: [{ key: '1', label: 'Yes' }] }),
    })
    expect(showsDialogCard(dialog, 0)).toBe(true)
    expect(showsDialogCard(dialog, 2)).toBe(true)
    const bare = agent({ status: 'blocked', inbox: inbox({ reason: 'blocked', source: 'dialog' }) })
    expect(showsDialogCard(bare, 0)).toBe(true)
    expect(showsDialogCard(bare, 1)).toBe(false)
    expect(showsDialogCard(agent({ inbox: inbox({ reason: 'trust', source: 'dialog' }) }), 0)).toBe(true)
    const menu = inbox({ reason: 'choice', source: 'menu', options: [{ key: 'nav:0', label: 'Opus' }] })
    expect(showsDialogCard(agent({ inbox: menu }), 0)).toBe(true)
    expect(
      showsDialogCard(agent({ inbox: inbox({ reason: 'blocked', source: 'panel', question: 'Status' }) }), 0),
    ).toBe(true)
    expect(showsDialogCard(agent({ inbox: inbox({ reason: 'done' }) }), 0)).toBe(false)
    expect(showsDialogCard(undefined, 0)).toBe(false)
  })

  test('blocking dialog needs options and a blocked status', () => {
    const options = [{ key: '1', label: 'Yes' }]
    expect(hasBlockingDialog(agent({ status: 'blocked', inbox: inbox({ options }) }))).toBe(true)
    expect(hasBlockingDialog(agent({ status: 'idle', inbox: inbox({ options }) }))).toBe(false)
    expect(hasBlockingDialog(agent({ status: 'blocked', inbox: inbox() }))).toBe(false)
  })
})

describe('agent names', () => {
  test('match what herdr accepts', () => {
    expect(AGENT_NAME_RE.test('reviewer')).toBe(true)
    expect(AGENT_NAME_RE.test('a1_b-c')).toBe(true)
    expect(AGENT_NAME_RE.test('1abc')).toBe(false)
    expect(AGENT_NAME_RE.test('Reviewer')).toBe(false)
    expect(AGENT_NAME_RE.test('a'.repeat(32))).toBe(true)
    expect(AGENT_NAME_RE.test('a'.repeat(33))).toBe(false)
  })

  test('kind short labels', () => {
    expect(kindShort('claude')).toBe('CC')
    expect(kindShort('codex')).toBe('CX')
    expect(kindShort('gemini')).toBe('GE')
  })
})

describe('turn helpers', () => {
  const steps: Item[] = [
    { type: 'text', text: 'first', ts: 1 },
    {
      type: 'tool',
      id: 'a',
      tool: 'edit',
      op: 'edit',
      detail: 'src/a.ts',
      path: '/home/alice/project/src/a.ts',
      status: 'ok',
      added: 2,
      removed: 1,
      ts: 2,
    },
    {
      type: 'tool',
      id: 'b',
      tool: 'edit',
      op: 'write',
      detail: 'src/a.ts',
      path: '/home/alice/project/src/a.ts',
      status: 'ok',
      added: 3,
      ts: 3,
    },
    { type: 'tool', id: 'c', tool: 'edit', op: 'create', detail: 'b.md', status: 'ok', added: 1, removed: 0, ts: 4 },
    { type: 'tool', id: 'd', tool: 'cmd', op: 'run', detail: 'ls', status: 'ok', ts: 5 },
    { type: 'text', text: 'final', ts: 6 },
    { type: 'think', ts: 7 },
  ]

  test('last reply text', () => {
    const turn: Turn = { id: '1', user: null, steps, start: 0, end: 1 }
    expect(lastReplyText(turn)).toBe('final')
    expect(lastReplyText({ ...turn, steps: [] })).toBe('')
  })

  test('interrupt marker and long user messages', () => {
    expect(INTERRUPTED_RE.test('[Request interrupted by user]')).toBe(true)
    expect(INTERRUPTED_RE.test('[Request interrupted by user for tool use]')).toBe(true)
    expect(INTERRUPTED_RE.test('please stop')).toBe(false)
    expect(isLongUserText('x'.repeat(901))).toBe(true)
    expect(isLongUserText(Array(16).fill('l').join('\n'))).toBe(true)
    expect(isLongUserText('short')).toBe(false)
  })

  test('command source', () => {
    expect(commandSourceKey({ name: 'x', desc: '', type: 'builtin', origin: 'builtin' })).toBe('builtin')
    expect(commandSourceKey({ name: 'x', desc: '', type: 'skill', origin: 'plugin' })).toBe('plugin')
    expect(commandSourceKey({ name: 'x', desc: '', type: 'command', origin: 'project' })).toBe('project')
    expect(commandSourceKey({ name: 'x', desc: '', type: 'skill', origin: 'user' })).toBe('skill')
    expect(commandSourceKey({ name: 'x', desc: '', type: 'command', origin: 'user' })).toBe('command')
  })
})

describe('models', () => {
  const catalog: ModelCatalog = {
    models: [
      { id: '', label: 'Default', efforts: ['low', 'high'] },
      { id: 'claude-opus-5-5[1m]', label: 'Opus 5.5 (1M)', efforts: ['low', 'medium', 'high', 'max'], effort: 'high' },
      { id: 'sonnet', label: 'Sonnet 5.5', efforts: [] },
    ],
    default: { model: 'claude-opus-5-5[1m]', effort: 'medium' },
  }

  test('current model from the transcript id or the status line label', () => {
    expect(currentModel(catalog.models, { transcriptModel: 'claude-opus-5-5[1m]' })?.label).toBe('Opus 5.5 (1M)')
    expect(currentModel(catalog.models, { transcriptModel: 'claude-opus-5-5' })?.label).toBe('Opus 5.5 (1M)')
    expect(currentModel(catalog.models, { transcriptModel: 'claude-sonnet-5-5' })?.label).toBe('Sonnet 5.5')
    expect(currentModel(catalog.models, { statusModel: 'Opus 5.5 (1M context)' })?.label).toBe('Opus 5.5 (1M)')
    expect(currentModel(catalog.models, {})).toBeNull()
  })

  test('labels prefer the catalog', () => {
    expect(modelLabel('sonnet', catalog)).toBe('Sonnet 5.5')
    expect(modelLabel('claude-haiku-4-5', catalog)).toBe('Haiku 4.5')
    expect(modelLabel(null, catalog)).toBe('')
  })

  test('remembered pick resolution', () => {
    const fresh = resolveModelPick(catalog, {})
    expect(fresh.model?.id).toBe('claude-opus-5-5[1m]')
    expect(fresh.modelId).toBe('')
    expect(fresh.effort).toBe('high')
    expect(fresh.pickedEffort).toBe('')

    const picked = resolveModelPick(catalog, { model: 'sonnet', effort: 'low' })
    expect(picked.model?.label).toBe('Sonnet 5.5')
    expect(picked.modelId).toBe('sonnet')
    expect(picked.effort).toBe('low')
    expect(picked.efforts).toEqual(['low', 'high', 'medium', 'max'])

    const unknown = resolveModelPick(catalog, { model: 'gone', effort: 'turbo' })
    expect(unknown.model?.id).toBe('')
    expect(unknown.modelId).toBe('')
    expect(unknown.pickedEffort).toBe('')
    expect(unknown.effort).toBe('medium')
    expect(unknown.defaultEffort).toBe('medium')
  })

  test('catalog efforts are the union across models', () => {
    expect(catalogEfforts(catalog)).toEqual(['low', 'high', 'medium', 'max'])
    expect(catalogEfforts(null)).toEqual([])
  })
})

describe('dialog actions carry what was clicked', () => {
  const dialog = { question: 'Do you want to make this edit to src/main.ts?' }

  test('an option goes with its label and the question, not just a cursor offset', () => {
    expect(optionAction('w1:p2', dialog, { key: 'nav:1', label: 'Yes, and allow all edits' })).toEqual({
      op: 'option',
      pane: 'w1:p2',
      key: 'nav:1',
      label: 'Yes, and allow all edits',
      question: 'Do you want to make this edit to src/main.ts?',
    })
  })

  test('a free-text answer is added; an empty question is sent, so the server still checks it', () => {
    expect(optionAction('w1:p2', { question: '' }, { key: '4', label: 'Other' }, 'use pnpm')).toEqual({
      op: 'option',
      pane: 'w1:p2',
      key: '4',
      label: 'Other',
      question: '',
      text: 'use pnpm',
    })
    expect(optionAction('w1:p2', {}, { key: '1', label: 'Yes' })).toEqual({
      op: 'option',
      pane: 'w1:p2',
      key: '1',
      label: 'Yes',
    })
  })
})

describe('live card identity', () => {
  test('a Codex question is keyed by the question alone, not by the agent state around it', () => {
    const ask = { call: 'call_1', title: 'Which directory?', options: ['One', 'Two'] }
    expect(cardKey(ask)).toBe('ask:call_1|Which directory?')
    expect(cardKey(ask)).not.toBe(cardKey({ ...ask, call: 'call_2' }))
  })

  test('a dialog is keyed by its reason and question', () => {
    const a = inbox({ reason: 'choice', source: 'dialog', question: 'Pick a database' })
    const withOptions = inbox({ ...a, options: [{ key: '1', label: 'Postgres' }] })
    expect(cardKey(a)).toBe(cardKey(withOptions))
    expect(cardKey(a)).not.toBe(cardKey({ ...a, question: 'Pick a cache' }))
    expect(cardKey(a)).not.toBe(cardKey({ call: 'x', title: 'Pick a database' }))
  })
})

describe('history controls', () => {
  const thread = (more: number, meta: { truncated?: boolean; maxTurns?: number } = {}) => ({
    more,
    meta: { truncated: false, maxTurns: 1000, ...meta },
  })

  test('load a page at a time while the API can return more', () => {
    expect(historyControls(thread(75), 30, 30)).toEqual({
      loadMore: 30,
      available: 75,
      nextLimit: 60,
      unavailable: false,
    })
    expect(historyControls(thread(12), 60, 30)).toEqual({
      loadMore: 12,
      available: 12,
      nextLimit: 72,
      unavailable: false,
    })
  })

  test('stop at the server limit instead of offering turns it never returns', () => {
    expect(historyControls(thread(500), 990, 30)).toMatchObject({ loadMore: 10, nextLimit: 1000 })
    // The review probe: 2001 turns, a limit already at the ceiling, `more: 1` forever.
    expect(historyControls(thread(1), 1000, 30)).toEqual({
      loadMore: 0,
      available: 0,
      nextLimit: 1000,
      unavailable: true,
    })
    expect(historyControls(thread(1), 2060, 30).loadMore).toBe(0)
  })

  test('say so when older history was dropped', () => {
    expect(historyControls(thread(0, { truncated: true }), 30, 30)).toMatchObject({ loadMore: 0, unavailable: true })
    expect(historyControls(thread(0), 30, 30).unavailable).toBe(false)
    expect(historyControls(thread(40, { truncated: true }), 30, 30)).toMatchObject({ loadMore: 30, unavailable: false })
  })
})

const turnOf = (steps: Item[]): Turn => ({ id: 't1', user: null, steps, start: 0, end: 0 })
const threadOf = (steps: Item[], live: { text: string; at: number } | null = null) => ({
  turns: [turnOf(steps)],
  meta: { live },
})
const tool = (over: Partial<ToolItem>): ToolItem => ({
  type: 'tool',
  id: 'x',
  tool: 'edit',
  op: 'write',
  detail: '',
  status: 'running',
  ts: 0,
  ...over,
})

describe('livePreview', () => {
  test('shows what the screen has that the transcript does not', () => {
    const thread = threadOf([{ type: 'text', text: 'Intro.', ts: 0 }], { text: '| # | input |\n|---|---|', at: 1 })
    expect(livePreview(thread)).toBe('| # | input |\n|---|---|')
  })

  test('drops it once the newest reply starts with it, and when there is none', () => {
    const thread = threadOf([{ type: 'text', text: 'All  20 tests\npass. Done.', ts: 0 }], {
      text: 'All 20 tests pass.',
      at: 1,
    })
    expect(livePreview(thread)).toBe('')
    expect(livePreview(threadOf([], null))).toBe('')
    expect(livePreview(threadOf([], { text: '  ', at: 1 }))).toBe('')
    expect(livePreview(null)).toBe('')
  })
})

describe('pendingChange', () => {
  const write = tool({ path: '/r/cli.js', detail: 'cli.js', diff: '+a\n+b' })

  test('the running edit the question names', () => {
    expect(pendingChange(threadOf([write]), 'Create file\n 38 }\nDo you want to create cli.js?')).toBe(write)
  })

  test('a running command, matched by its start across wrapped lines', () => {
    const cmd = tool({ tool: 'cmd', op: 'run', detail: 'npm test 2>&1 | grep -E "tests|pass"' })
    expect(pendingChange(threadOf([cmd]), 'Bash command\n  npm test 2>&1 | grep -E\n  "tests|pass"\nProceed?')).toBe(
      cmd,
    )
  })

  test('never another tool: finished, unnamed or not a change', () => {
    expect(pendingChange(threadOf([{ ...write, status: 'ok' }]), 'create cli.js?')).toBeNull()
    expect(pendingChange(threadOf([write]), 'Do you want to create slug.js?')).toBeNull()
    const plan = tool({ tool: 'plan', op: 'plan', output: 'cli.js plan' })
    expect(pendingChange(threadOf([plan]), 'Proceed with cli.js?')).toBeNull()
    expect(pendingChange(null, 'cli.js')).toBeNull()
  })

  test('an earlier running edit when the newest is about another file', () => {
    const other = tool({ id: 'y', path: '/r/b.js', detail: 'b.js' })
    expect(pendingChange(threadOf([write, other]), 'Do you want to create cli.js?')).toBe(write)
  })
})

describe('splitQuestion', () => {
  test('the TUI preview and the question in its last line', () => {
    expect(splitQuestion(' 38 }\n 39 x\nDo you want to create cli.js?')).toEqual({
      preview: ' 38 }\n 39 x',
      ask: 'Do you want to create cli.js?',
    })
    expect(splitQuestion('Read file\n要继续吗？')).toEqual({ preview: 'Read file', ask: '要继续吗？' })
  })

  test('no question line: all of it is the preview', () => {
    expect(splitQuestion('Bash command\nrm -rf build')).toEqual({ preview: 'Bash command\nrm -rf build', ask: '' })
    expect(splitQuestion('Proceed?')).toEqual({ preview: 'Proceed?', ask: '' })
  })
})

describe('changeLines', () => {
  test('the lines, and whether the server cut them short', () => {
    expect(changeLines({ diff: '+a\n+b\n' })).toEqual({ lines: ['+a', '+b'], clipped: false })
    expect(changeLines({ diff: '+a\n… (1200 more chars)' })).toEqual({ lines: ['+a'], clipped: true })
    expect(changeLines({})).toEqual({ lines: [], clipped: false })
  })
})

describe('sendButtonMode', () => {
  const base = { working: true, empty: true, uploading: false, sentAt: 0, stopSince: 0, now: 10_000 }

  test('a double click: the second click lands on a pending button, not on Stop', () => {
    expect(sendButtonMode({ ...base, empty: false })).toBe('send')
    const sentAt = 10_000
    expect(sendButtonMode({ ...base, sentAt, stopSince: sentAt, now: sentAt + 100 })).toBe('pending')
    expect(sendButtonMode({ ...base, sentAt, stopSince: sentAt, now: sentAt + SEND_GUARD_MS })).toBe('stop')
  })

  test('Stop arms only a moment after it would appear', () => {
    expect(sendButtonMode({ ...base, stopSince: 9_900 })).toBe('armingStop')
    expect(sendButtonMode({ ...base, stopSince: 1 })).toBe('stop')
  })

  test('uploads hold the send; an idle empty composer has nothing to do', () => {
    expect(sendButtonMode({ ...base, empty: false, uploading: true })).toBe('uploading')
    expect(sendButtonMode({ ...base, uploading: true })).toBe('uploading')
    expect(sendButtonMode({ ...base, working: false })).toBe('idle')
  })
})

describe('readingAnchor', () => {
  const blocks = [
    { key: 'a', top: 0, height: 100 },
    { key: 'b', top: 100, height: 300 },
    { key: 'c', top: 400, height: 50 },
  ]

  test('the block at the top edge and how far into it', () => {
    expect(readingAnchor(blocks, 0)).toEqual({ key: 'a', offset: 0 })
    expect(readingAnchor(blocks, 250)).toEqual({ key: 'b', offset: 150 })
    expect(readingAnchor(blocks, 100)).toEqual({ key: 'b', offset: 0 })
    expect(readingAnchor(blocks, 900)).toEqual({ key: 'c', offset: 500 })
    expect(readingAnchor([], 10)).toBeNull()
  })
})

describe('homeTarget', () => {
  const ws = (id: string) => ({ id, label: id, number: 0, cwd: '', busy: false, agents: 0 })
  const base = {
    pick: null,
    newName: null,
    workspaces: [ws('w1'), ws('w2'), ws('w3')],
    panes: [
      { workspace: 'w1', cwd: '/home/a/projects' },
      { workspace: 'w3', cwd: '/home/a/projects/web/' },
      { workspace: 'w2', cwd: '/home/a/projects/web' },
      { workspace: 'hidden', cwd: '/home/a/other' },
    ],
  }

  test('the first workspace in the sidebar with a pane in that folder', () => {
    expect(homeTarget({ ...base, dir: '/home/a/projects' })).toEqual({ workspace: 'w1' })
    expect(homeTarget({ ...base, dir: '/home/a/projects/web/' })).toEqual({ workspace: 'w2' })
  })

  test('otherwise a new workspace named after the folder; folders above and hidden workspaces do not count', () => {
    expect(homeTarget({ ...base, dir: '/home/a/projects/c' })).toEqual({ newWorkspace: 'c' })
    expect(homeTarget({ ...base, dir: '/home/a/projects/web/src' })).toEqual({ newWorkspace: 'src' })
    expect(homeTarget({ ...base, dir: '/home/a/other' })).toEqual({ newWorkspace: 'other' })
  })

  test('an explicit pick or a new name wins', () => {
    expect(homeTarget({ ...base, dir: '/home/a/c', pick: 'w1' })).toEqual({ workspace: 'w1' })
    expect(homeTarget({ ...base, dir: '/home/a/projects', newName: 'mine' })).toEqual({ newWorkspace: 'mine' })
    expect(homeTarget({ ...base, dir: '/home/a/c', pick: 'gone' })).toEqual({ newWorkspace: 'c' })
  })

  test('folderLabel', () => {
    expect(folderLabel('/a/b/c/')).toBe('c')
    expect(folderLabel('/a/-x')).toBe('x')
    expect(folderLabel('/')).toBe('workspace')
  })
})

describe('groupSteps', () => {
  const run = (detail: string, kind: ToolItem['tool'] = 'cmd', status: ToolItem['status'] = 'ok'): ToolItem => ({
    type: 'tool',
    id: detail,
    tool: kind,
    op: 'run',
    detail,
    status,
    ts: 1,
  })
  const text = (t: string): Item => ({ type: 'text', text: t, ts: 1 })

  test('runs of tool calls between messages fold into one block; thinking does not break a run', () => {
    const steps: Item[] = [
      text('first'),
      run('a'),
      { type: 'think', ts: 1 },
      run('b', 'read'),
      run('c'),
      text('second'),
      run('d', 'cmd', 'error'),
    ]
    const blocks = groupSteps(steps)
    expect(blocks.map(b => (b.type === 'run' ? `run:${b.steps.map(s => s.step.detail).join('')}` : b.index))).toEqual([
      0,
      'run:abc',
      5,
      'run:d',
    ])
    const first = blocks[1]
    expect(first?.type === 'run' && runCounts(first.steps)).toEqual([
      ['cmd', 2],
      ['read', 1],
    ])
    expect(blocks[3]).toMatchObject({ type: 'run', index: 6, failed: 1, running: false })
  })

  test('edits, plans, todos and questions stay on their own and split runs; a running call marks its run', () => {
    const edit = run('e', 'edit')
    const blocks = groupSteps([run('a'), edit, run('b', 'search', 'running')])
    expect(blocks.map(b => b.type)).toEqual(['run', 'step', 'run'])
    expect(blocks[2]).toMatchObject({ running: true })
  })
})

describe('turn prompts', () => {
  const turn = (id: string, text: string, extra = {}): Turn => ({
    id,
    user: { type: 'user', text, images: 0, ts: 0, ...extra },
    steps: [],
    start: 0,
    end: 0,
  })

  test('lists what the user sent, not interruptions', () => {
    const turns: Turn[] = [
      turn('a', 'fix   the\nbuild'),
      turn('b', '[Request interrupted by user]'),
      { id: 'c', user: null, steps: [], start: 0, end: 0 },
      turn('d', '', { answers: [{ question: 'Q', answer: 'Yes' }] }),
      turn('e', 'x'.repeat(400)),
    ]
    const prompts = turnPrompts(turns)
    expect(prompts.map(m => m.id)).toEqual(['a', 'd', 'e'])
    expect(prompts[0].preview).toBe('fix the build')
    expect(prompts[1].preview).toBe('Yes')
    expect(prompts[2].preview).toHaveLength(300)
  })
})

describe('usage chip', () => {
  const w = (kind: 'session' | 'week', usedPercent: number, scope: string | null = null) => ({
    kind,
    scope,
    usedPercent,
    resetsAt: null,
  })
  const account = (windows: ReturnType<typeof w>[]) => ({
    provider: 'claude' as const,
    label: null,
    plan: null,
    windows,
  })

  test("shows the plan's session, else its week, else the model limit nearest its end", () => {
    expect(usageChip(account([w('week', 30), w('session', 12.4)]))).toMatchObject({ left: 88, hot: false })
    expect(usageChip(account([w('week', 85), w('week', 99, 'Opus')]))).toMatchObject({ left: 15, hot: true })
    expect(usageChip(account([w('week', 20, 'Opus'), w('week', 60, 'Sonnet')]))?.window.scope).toBe('Sonnet')
    expect(usageChip(account([]))).toBeNull()
  })
})
