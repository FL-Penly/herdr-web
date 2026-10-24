import { describe, expect, test } from 'bun:test'
import { ClaudeTranscriptParser, userText } from '../../../src/agents/claude/transcript.ts'
import { fixture, items, parseFile, tool, tools } from '../helpers.ts'

const CWD = '/home/alice/project'
const session = () => parseFile(new ClaudeTranscriptParser(), fixture('claude', 'session.jsonl'))
const commands = () => parseFile(new ClaudeTranscriptParser(), fixture('claude', 'commands.jsonl'))

describe('ClaudeTranscriptParser: replies and tools', () => {
  test('user, thinking and text items; sidechain, meta and injected rows are skipped', () => {
    const kinds = items(session()).filter(i => i.type !== 'tool')
    expect(kinds.map(i => (i.type === 'user' || i.type === 'text' ? `${i.type}:${i.text}` : i.type))).toEqual([
      'user:Fix the failing parser test',
      'think',
      "text:I'll run the tests first.",
      'text:Synthetic notice',
      'text:Fixed: the parser now handles 中文 text.',
      'user:Looks good, see screenshot',
      'text:Thanks!',
    ])
  })

  test('thinking shown as progress updates (thinkingDisplay: updates) is a message, as the TUI prints it', () => {
    const parser = new ClaudeTranscriptParser()
    const row = (uuid: string, thinkingDisplay: string | undefined, thinking: string) => ({
      type: 'assistant',
      uuid,
      timestamp: '2026-03-10T08:00:00Z',
      thinkingDisplay,
      message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking, signature: 'x' }] },
    })
    parser.ingest(row('a1', 'updates', 'Half of it is clear: the pane shows a background job.\n\n'), {
      start: 0,
      end: 1,
    })
    parser.ingest(row('a2', 'updates', ''), { start: 1, end: 2 })
    parser.ingest(row('a3', undefined, 'private reasoning'), { start: 2, end: 3 })
    expect(items(parser.snapshot()).map(i => (i.type === 'text' ? `text:${i.text}` : i.type))).toEqual([
      'text:Half of it is clear: the pane shows a background job.',
      'think',
      'think',
    ])
  })

  test('text items carry the assistant uuid as their fork mark', () => {
    const texts = items(session()).filter(i => i.type === 'text')
    expect(texts[0]?.forkAt).toBe('aaaaaaaa-0000-4000-8000-000000000001')
    expect(texts.at(-1)?.forkAt).toBe('aaaaaaaa-0000-4000-8000-000000000003')
  })

  test('images are counted', () => {
    const user = items(session()).filter(i => i.type === 'user')[1]
    expect(user).toMatchObject({ type: 'user', text: 'Looks good, see screenshot', images: 1 })
  })

  test('model ignores <synthetic>; effort comes from the assistant rows', () => {
    const t = session()
    expect(t.model).toBe('claude-opus-5-5')
    expect(t.effort).toBe('high')
    expect(t.cwd).toBe(CWD)
  })

  test('every tool maps to a kind and op', () => {
    const got = tools(session()).map(t => [t.id, t.tool, t.op])
    expect(got).toEqual([
      ['toolu_bash', 'cmd', 'run'],
      ['toolu_read', 'read', 'file'],
      ['toolu_edit', 'edit', 'edit'],
      ['toolu_multi', 'edit', 'edit'],
      ['toolu_write', 'edit', 'write'],
      ['toolu_grep', 'search', 'grep'],
      ['toolu_glob', 'search', 'search'],
      ['toolu_fetch', 'web', 'fetch'],
      ['toolu_search', 'web', 'search'],
      ['toolu_task', 'task', 'task'],
      ['toolu_todo', 'todo', 'update'],
      ['toolu_plan', 'plan', 'plan'],
      ['toolu_skill', 'skill', 'skill'],
      ['toolu_ask', 'ask', 'ask'],
      ['toolu_mcp', 'other', 'call'],
      ['toolu_pending', 'cmd', 'run'],
    ])
  })

  test('tool details, diffs and results', () => {
    const t = session()
    expect(tool(t, 'toolu_bash')).toMatchObject({ detail: 'bun test', status: 'ok', output: 'Exit code 1\n1 fail' })
    expect(tool(t, 'toolu_read')).toMatchObject({ detail: 'src/parser.ts', status: 'ok' })
    expect(tool(t, 'toolu_read').output).toBeUndefined()
    expect(tool(t, 'toolu_edit')).toMatchObject({
      path: `${CWD}/src/parser.ts`,
      added: 2,
      removed: 1,
      diff: '-const x = 1\n+const x = 2\n+const y = 3',
      status: 'ok',
    })
    expect(tool(t, 'toolu_edit').output).toBeUndefined()
    expect(tool(t, 'toolu_multi')).toMatchObject({ added: 2, removed: 3, diff: '-a\n+b\n@@\n-c\n-d\n+e' })
    expect(tool(t, 'toolu_write')).toMatchObject({ detail: 'NOTES.md', added: 3, removed: 0 })
    expect(tool(t, 'toolu_grep').detail).toBe('parseRow  src')
    expect(tool(t, 'toolu_glob').detail).toBe('**/*.test.ts')
    expect(tool(t, 'toolu_fetch').detail).toBe('https://example.com/spec')
    expect(tool(t, 'toolu_search').detail).toBe('jsonl byte offsets')
    expect(tool(t, 'toolu_task')).toMatchObject({ detail: 'Survey callers', output: 'Found 3 callers' })
    expect(tool(t, 'toolu_todo').detail).toBe('1/2')
    expect(tool(t, 'toolu_plan')).toMatchObject({ detail: '1. Fix', output: '1. Fix\n2. Test', status: 'ok' })
    expect(tool(t, 'toolu_skill').detail).toBe('review')
    expect(tool(t, 'toolu_mcp')).toMatchObject({ name: 'github · create_issue', detail: '{"title":"Parser bug"}' })
    expect(tool(t, 'toolu_mcp').status).toBe('running')
  })

  test('AskUserQuestion shows the questions and the answer', () => {
    expect(tool(session(), 'toolu_ask')).toMatchObject({
      detail: 'Which fix?',
      status: 'ok',
      output: expect.stringContaining('"Which fix?"="Small"'),
    })
  })

  test('tool_result rows outside user rows (api-request-blob) are ignored', () => {
    expect(tool(session(), 'toolu_pending').status).toBe('running')
  })

  test('TodoWrite updates the todo list, keeping only content and status', () => {
    expect(session().todos).toEqual([
      { content: 'Fix parser', status: 'completed' },
      { content: 'Add test', status: 'in_progress' },
    ])
  })

  test('long tool output is clipped', () => {
    const p = new ClaudeTranscriptParser()
    p.ingest(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
      { start: 0, end: 1 },
    )
    p.ingest(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(7000), is_error: true }] },
      },
      { start: 1, end: 2 },
    )
    const out = tools(p.snapshot())[0]
    expect(out?.status).toBe('error')
    expect(out?.output).toEndWith('\n… (1000 more chars)')
  })
})

describe('ClaudeTranscriptParser: commands, effort and goals', () => {
  test('silent commands are hidden, commands with args or not silent are shown', () => {
    const users = items(commands()).filter(i => i.type === 'user')
    expect(users.map(u => u.type === 'user' && u.text)).toEqual([
      '/compact keep the API notes',
      '/review',
      '/goal All tests pass',
    ])
  })

  test('local command output becomes notes, ANSI stripped, empty output skipped', () => {
    const notes = items(commands()).filter(i => i.type === 'note')
    expect(notes.map(n => n.type === 'note' && [n.code, n.text])).toEqual([
      ['command', 'Set effort level to medium (saved as your default for new sessions): Balanced approach'],
      ['command', 'Compacted (ctrl+o to see full summary)'],
      ['command', 'Set model to `Fable 5.1` for this session only with `low` effort'],
      ['goal.complete', 'The test run shows 0 failures.'],
      ['goal.cleared', 'Goal cleared'],
    ])
  })

  test('effort follows `/effort` and `/model … with X effort` output', () => {
    const p = new ClaudeTranscriptParser()
    const rows = parseFile(p, fixture('claude', 'commands.jsonl'))
    expect(rows.effort).toBe('low')
    const q = new ClaudeTranscriptParser()
    q.ingest(
      {
        type: 'user',
        message: { content: '<local-command-stdout>Set effort level to xhigh (saved)</local-command-stdout>' },
      },
      { start: 0, end: 1 },
    )
    q.ingest({ type: 'assistant', effort: 'medium', message: { content: [] } }, { start: 1, end: 2 })
    expect(q.snapshot().effort).toBe('xhigh')
  })

  test('a message sent while the agent worked shows where it was taken in; notifications do not', () => {
    const p = new ClaudeTranscriptParser()
    const queued = (attachment: object, start: number) =>
      p.ingest({ type: 'attachment', timestamp: '2026-10-24T09:40:26Z', attachment }, { start, end: start + 1 })
    p.ingest(
      { type: 'user', timestamp: '2026-10-24T09:39:00Z', message: { content: 'Build the rail' } },
      { start: 0, end: 1 },
    )
    queued(
      { type: 'queued_command', prompt: 'also move it right', commandMode: 'prompt', origin: { kind: 'human' } },
      1,
    )
    queued(
      {
        type: 'queued_command',
        prompt: [
          { type: 'text', text: '[Image #23]如图[图片1]' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        ],
        commandMode: 'prompt',
        origin: { kind: 'human' },
        humanTurn: true,
      },
      2,
    )
    queued(
      {
        type: 'queued_command',
        prompt: '<task-notification>done</task-notification>',
        commandMode: 'task-notification',
      },
      3,
    )
    queued(
      { type: 'queued_command', prompt: 'hi from another session', commandMode: 'prompt', origin: { kind: 'peer' } },
      4,
    )
    expect(items(p.snapshot()).map(i => i.type === 'user' && [i.text, i.images])).toEqual([
      ['Build the rail', 0],
      ['also move it right', 0],
      ['[Image #23]如图[图片1]', 1],
    ])
  })

  test('goal_status: active, then met with stats; cleared afterwards', () => {
    const notes = items(commands()).filter(i => i.type === 'note' && i.code === 'goal.complete')
    expect(notes[0]).toMatchObject({
      goal: { text: 'All tests pass', status: 'complete', secs: 61, tokens: 12345, turns: 2 },
    })
    expect(commands().goal).toBeNull()
    const p = new ClaudeTranscriptParser()
    p.ingest(
      { type: 'attachment', attachment: { type: 'goal_status', met: false, condition: 'Ship it' } },
      { start: 0, end: 1 },
    )
    expect(p.snapshot().goal).toEqual({
      text: 'Ship it',
      status: 'active',
      secs: undefined,
      tokens: undefined,
      turns: undefined,
    })
    expect(p.snapshot().entries).toEqual([])
  })

  test('a met sentinel is `/goal clear`, not the goal being met', () => {
    const p = new ClaudeTranscriptParser()
    const goal = (met: boolean, sentinel?: boolean) => ({
      type: 'attachment',
      attachment: { type: 'goal_status', met, sentinel, condition: 'Ship it' },
    })
    p.ingest(goal(false, true), { start: 0, end: 1 })
    p.ingest(goal(false), { start: 1, end: 2 })
    expect(p.snapshot().goal?.status).toBe('active')
    p.ingest(goal(true, true), { start: 2, end: 3 })
    p.ingest(
      { type: 'user', message: { content: '<local-command-stdout>Goal cleared: Ship it</local-command-stdout>' } },
      { start: 3, end: 4 },
    )
    expect(p.snapshot().goal).toBeNull()
    expect(items(p.snapshot()).map(i => i.type === 'note' && i.code)).toEqual(['goal.cleared'])
  })
})

describe('userText', () => {
  test.each([
    ['plain text', 'plain text'],
    ['<command-name>/clear</command-name><command-args></command-args>', null],
    ['<command-name>/model</command-name><command-args>opus</command-args>', '/model opus'],
    ['<command-message>x</command-message><command-name>/x</command-name>', '/x'],
    ['<system-reminder>hi</system-reminder>', null],
    ['<bash-input>ls</bash-input>', null],
    ['<user-prompt-submit-hook>x', null],
    ['<custom>tag kept</custom>', '<custom>tag kept</custom>'],
  ])('%p → %p', (raw, want) => expect(userText(raw)).toBe(want))
})
