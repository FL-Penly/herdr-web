import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  CodexRolloutParser,
  askOutput,
  commandLine,
  diffStat,
  goalInToolOutput,
} from '../../../src/agents/codex/rollout.ts'
import { JsonlTail } from '../../../src/lib/jsonl.ts'
import type { UserItem } from '../../../src/protocol.ts'
import { fixture, items, parseFile, tool, tools } from '../helpers.ts'

const PATH = fixture('codex', 'rollout.jsonl')
const parse = () => parseFile(new CodexRolloutParser(PATH), PATH)
const users = () => items(parse()).filter((i): i is UserItem => i.type === 'user')

describe('CodexRolloutParser', () => {
  test('user messages, `/goal` from user_goal context, images', () => {
    expect(users().map(u => [u.text, u.images])).toEqual([
      ['/goal Ship the parser fix', 0],
      ['Please fix the parser', 1],
      ['Now deploy it', 0],
      ['', 0],
      ['', 0],
    ])
  })

  test('agent messages and reasoning', () => {
    const replies = items(parse()).filter(i => i.type === 'text' || i.type === 'think')
    expect(replies.map(i => (i.type === 'text' ? i.text : 'think'))).toEqual([
      '我先看看测试。',
      'think',
      'Done — 修好了。',
      'Deploying to staging.',
    ])
  })

  test('model, effort and cwd from turn_context', () => {
    const t = parse()
    expect([t.model, t.effort, t.cwd]).toEqual(['gpt-test', 'medium', '/home/alice/project'])
  })

  test('command executions: shell wrapper removed, exit status', () => {
    const t = parse()
    expect(tool(t, 'exec-1')).toMatchObject({
      tool: 'cmd',
      op: 'run',
      detail: 'bun test',
      status: 'ok',
      output: '3 pass\n',
    })
    expect(tool(t, 'exec-2')).toMatchObject({ detail: 'false', status: 'error' })
    expect(tool(t, 'exec-3')).toMatchObject({ detail: 'git status', status: 'ok' })
  })

  test('file changes: create / edit / delete with line counts', () => {
    const changes = tools(parse()).filter(t => t.tool === 'edit')
    expect(changes.map(c => [c.op, c.detail, c.added, c.removed])).toEqual([
      ['edit', 'src/parser.ts', 2, 1],
      ['create', 'src/new.ts', 2, 0],
      ['delete', '/tmp/old.ts', 0, 1],
    ])
    expect(changes[1]?.diff).toBe('+a\n+b')
  })

  test("a plan-mode plan keeps all of its markdown, without Codex's proposed_plan wrapper", () => {
    const p = new CodexRolloutParser('/x')
    const text = '<proposed_plan>\n# 修复计划\n\n## Summary\n- one\n- two\n</proposed_plan>'
    const item = { type: 'Plan', id: 'turn-plan', text }
    p.ingest({ type: 'event_msg', payload: { type: 'item_completed', item } }, { start: 0, end: 1 })
    expect(tools(p.snapshot())[0]).toMatchObject({
      tool: 'plan',
      status: 'ok',
      detail: '修复计划',
      output: '# 修复计划\n\n## Summary\n- one\n- two',
    })
  })

  test('a deleted file carries its old content: all lines removed', () => {
    const p = new CodexRolloutParser('/x')
    const change = { type: 'FileChange', id: 'fc', changes: { '/tmp/gone.ts': { type: 'delete', content: 'a\nb' } } }
    p.ingest({ type: 'event_msg', payload: { type: 'item_completed', item: change } }, { start: 0, end: 1 })
    expect(tools(p.snapshot())[0]).toMatchObject({ op: 'delete', added: 0, removed: 2, diff: '-a\n-b' })
  })

  test('plan, image view, MCP call, sub-agent start', () => {
    const t = parse()
    expect(tool(t, 't1-plan')).toMatchObject({ tool: 'plan', op: 'plan', detail: 'Plan', output: '# Plan\n1. Fix' })
    expect(tool(t, 'exec-5')).toMatchObject({ tool: 'read', op: 'image', detail: '/tmp/shot.png' })
    expect(tool(t, 'mcp-1')).toMatchObject({
      tool: 'other',
      op: 'call',
      name: 'github · create_issue',
      status: 'error',
    })
    expect(tool(t, 'sub-1')).toMatchObject({ tool: 'task', op: 'subagent', detail: '/root/explorer' })
    expect(tools(t).filter(x => x.op === 'subagent')).toHaveLength(1)
  })

  test('a sync ask is answered by its function_call_output', () => {
    expect(tool(parse(), 'call_sync')).toMatchObject({
      tool: 'ask',
      op: 'ask',
      detail: 'Fix only the parser?',
      status: 'ok',
      output: 'Fix only the parser?\n● Parser only\n○ Everything',
    })
  })

  test('async asks: answered by questionItemId or by title; the rest expire with the turn', () => {
    const t = parse()
    expect(users()[3]?.answers).toEqual([{ question: 'Which environment?', answer: 'staging' }])
    expect(users()[4]?.answers).toEqual([{ question: 'Run migrations?', answer: 'Yes' }])
    expect(tool(t, 'call_async')).toMatchObject({
      status: 'running',
      output: 'Which environment?\n\n→ staging\n\nNotify the team?\n○ Yes\n○ No',
    })
    expect(tool(t, 'call_async2')).toMatchObject({ status: 'ok', output: 'Run migrations?\n● Yes\n○ No' })
    expect(t.pending).toEqual([])
  })

  test('async asks stay pending until their turn ends', () => {
    const parser = new CodexRolloutParser(PATH)
    for (const { row, start, end } of new JsonlTail(PATH).read().rows) {
      if ((row as { payload?: { turn_id?: string } }).payload?.turn_id === 't2') break
      parser.ingest(row, { start, end })
    }
    expect(parser.snapshot().pending.map(a => a.title)).toEqual(['Notify the team?', 'Run migrations?'])
  })

  test('goal notes: paused, complete (from a script tool output), cleared', () => {
    const notes = items(parse()).filter(i => i.type === 'note')
    expect(notes.map(n => n.type === 'note' && n.code)).toEqual(['goal.paused', 'goal.complete', 'goal.cleared'])
    expect(notes[0]).toMatchObject({ goal: { status: 'paused', secs: 30, tokens: 1000 } })
    expect(notes[1]).toMatchObject({
      goal: { text: 'Ship the {parser} "fix"', status: 'complete', secs: 95, tokens: 4321 },
    })
    expect(parse().goal).toBeNull()
  })

  test('task_complete marks the last item with the exact byte offset after its line', () => {
    const marks = items(parse()).flatMap(i => (i.forkAt ? [i.forkAt] : []))
    expect(marks).toHaveLength(3)
    const bytes = readFileSync(PATH)
    for (const mark of marks) {
      const [path, offset] = [mark.slice(0, mark.lastIndexOf('#')), Number(mark.slice(mark.lastIndexOf('#') + 1))]
      expect(path).toBe(PATH)
      expect(bytes[offset - 1]).toBe(0x0a)
      const lastLine =
        bytes
          .subarray(0, offset - 1)
          .toString()
          .split('\n')
          .pop() ?? ''
      expect(JSON.parse(lastLine).payload.type).toBe('task_complete')
    }
    const texts = items(parse()).filter(i => i.type === 'text')
    expect(texts[1]?.forkAt).toBe(marks[0])
    expect(texts[2]?.forkAt).toBe(marks[1])
    expect(items(parse()).at(-1)).toMatchObject({ type: 'note', code: 'goal.cleared', forkAt: marks[2] })
  })

  test('goal status changes other than paused/complete are noted with the status', () => {
    const p = new CodexRolloutParser('/x')
    const goal = (status: string) => ({
      type: 'event_msg',
      payload: { type: 'thread_goal_updated', goal: { objective: 'g', status } },
    })
    p.ingest(goal('active'), { start: 0, end: 1 })
    p.ingest(goal('blocked'), { start: 1, end: 2 })
    p.ingest(goal('blocked'), { start: 2, end: 3 })
    expect(items(p.snapshot())).toEqual([
      {
        type: 'note',
        code: 'goal.status',
        text: 'blocked',
        goal: { text: 'g', status: 'blocked', secs: undefined, tokens: undefined },
        ts: 0,
      },
    ])
  })

  test('an unparseable question reply still counts as answers', () => {
    const p = new CodexRolloutParser('/x')
    const text = '<send_user_message_question_reply>\nnot json\n</send_user_message_question_reply>'
    p.ingest(
      {
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } },
      },
      { start: 0, end: 1 },
    )
    expect(items(p.snapshot())).toEqual([{ type: 'user', text: '', images: 0, answers: [], ts: 0 }])
  })
})

describe('helpers', () => {
  test('goalInToolOutput reads JSON strings and script text parts, not prose', () => {
    const g = { threadId: 't', objective: 'o', status: 'complete' }
    expect(goalInToolOutput(JSON.stringify({ goal: g }, null, 2))).toEqual(g)
    expect(
      goalInToolOutput([
        { type: 'input_text', text: 'Script completed' },
        { type: 'input_text', text: JSON.stringify({ goal: g }) },
      ]),
    ).toEqual(g)
    expect(goalInToolOutput(`log: ${JSON.stringify({ goal: g })}`)).toBeNull()
    expect(goalInToolOutput(JSON.stringify({ goal: { status: 'complete' } }))).toBeNull()
  })

  test('diffStat skips file headers but counts changed lines that start with ++ or --', () => {
    expect(diffStat('--- a/x.md\n+++ b/x.md\n@@ -1,3 +1,2 @@\n----\n-- note\n+++i\n keep')).toEqual({
      added: 1,
      removed: 2,
    })
    expect(diffStat('@@ -1 +1 @@\n-old\n+new')).toEqual({ added: 1, removed: 1 })
  })

  test('commandLine unwraps `<shell> -lc`', () => {
    expect(commandLine(['/usr/bin/zsh', '-lc', 'ls -la'])).toBe('ls -la')
    expect(commandLine(['bash', '-lc', 'a', 'b'])).toBe('a b')
    expect(commandLine(['git', 'log', '-1'])).toBe('git log -1')
    expect(commandLine('echo hi')).toBe('echo hi')
  })

  test('askOutput marks the chosen option or shows a free-form answer', () => {
    expect(askOutput([{ call: 'c', title: 'Q', options: ['A', 'B'], answer: 'B' }])).toBe('Q\n○ A\n● B')
    expect(askOutput([{ call: 'c', title: 'Q', options: ['A'], answer: 'other' }])).toBe('Q\n○ A\n→ other')
  })
})
