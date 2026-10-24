import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, Snapshot } from '../../src/herdr.ts'
import { type InboxDeps, InboxService, InboxStore } from '../../src/inbox/index.ts'
import { screen } from '../tui/fixtures.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-web-service-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const T = 1_800_000_000_000

function agent(over: Partial<Agent>): Agent {
  return {
    pane_id: 'w1:p1',
    tab_id: 'w1:t1',
    workspace_id: 'w1',
    cwd: '/home/alice/project',
    agent: 'claude',
    agent_status: 'idle',
    agent_session: { value: '11111111-1111-4111-8111-111111111111' },
    completion_seq: 1,
    state_change_seq: 1,
    terminal_title_stripped: 'Refactor parser | project',
    ...over,
  }
}

function snapshot(...agents: Agent[]): Snapshot {
  return {
    workspaces: [{ workspace_id: 'w1', label: 'dev', number: 1, agent_status: 'idle' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main', number: 1 }],
    panes: agents,
    agents,
    layouts: [],
  }
}

function service(screens: Record<string, string>, over: Partial<InboxDeps> = {}) {
  let now = T
  const io = { transcriptReads: 0, live: [] as { pane: string; cwd: string }[][] }
  const svc = new InboxService(new InboxStore(join(dir, 'state.json')), {
    readScreen: async pane => screens[pane] ?? '',
    locateTranscript: async () => '/home/alice/.claude/projects/x/s.jsonl',
    lastReply: () => {
      io.transcriptReads++
      return { text: 'Want me to open a PR?', at: T - 60_000 }
    },
    branchStatus: async () => ({ name: 'main', ahead: 1, behind: 0 }),
    liveCodexPanes: list => void io.live.push(list),
    now: () => now,
    ...over,
  })
  return { svc, io, tick: (ms: number) => (now += ms) }
}

describe('InboxService.build', () => {
  test('a view with status-line fields, labels and the inbox entry', async () => {
    const { svc } = service({ 'w1:p1': screen('claude-idle-restored') })
    const [v] = await svc.build(snapshot(agent({ name: 'parser' })))
    expect(v).toMatchObject({
      pane: 'w1:p1',
      workspaceLabel: 'dev',
      tabLabel: 'main',
      kind: 'claude',
      name: 'parser',
      title: 'Refactor parser',
      status: 'idle',
      branch: { name: 'main', ahead: 1, behind: 0 },
      ctx: 20,
      mode: 'accept edits',
      model: 'Opus 5.5 (1M context)',
      ultra: false,
      activity: null,
      asks: 0,
      inbox: { reason: 'question', source: 'transcript', message: 'Want me to open a PR?' },
    })
    expect(v?.since).toBe(T - 60_000)
  })

  test('status-line values survive a dialog hiding the footer', async () => {
    const screens: Record<string, string> = { 'w1:p1': screen('claude-busy') }
    const { svc } = service(screens)
    await svc.build(snapshot(agent({ agent_status: 'working' })))
    screens['w1:p1'] = screen('claude-permission')
    const [v] = await svc.build(snapshot(agent({ agent_status: 'blocked', state_change_seq: 2 })))
    expect(v).toMatchObject({ ctx: 19, mode: 'bypass permissions', effort: 'medium', ultra: true })
    expect(v?.inbox).toMatchObject({ reason: 'permission', source: 'dialog' })
  })

  test('a pane paged away from its dialog keeps its view until a moment after it is back', async () => {
    const screens: Record<string, string> = { 'w1:p1': screen('claude-permission') }
    const { svc, tick } = service(screens)
    await svc.build(snapshot(agent({ agent_status: 'blocked', state_change_seq: 2 })))
    // herdr sees no dialog on the paged screen either, and calls the agent working.
    const paged = snapshot(agent({ agent_status: 'working', state_change_seq: 3 }))
    await svc.whileScrolled('w1:p1', async () => {
      screens['w1:p1'] = screen('claude-scroll/p05')
      const [v] = await svc.build(paged)
      expect(v).toMatchObject({ status: 'blocked', inbox: { reason: 'permission', source: 'dialog' } })
    })
    const [settling] = await svc.build(paged)
    expect(settling?.status).toBe('blocked')
    tick(2500)
    const [after] = await svc.build(paged)
    expect(after?.status).toBe('working')
  })

  test('a view read while paging began is not taken for the pane', async () => {
    const screens: Record<string, string> = { 'w1:p1': screen('claude-permission') }
    let release = () => {}
    let slow = false
    const { svc } = service(screens, {
      readScreen: async pane => {
        const shown = screens[pane] ?? ''
        if (slow) await new Promise<void>(r => (release = r))
        return shown
      },
    })
    const blocked = snapshot(agent({ agent_status: 'blocked', state_change_seq: 2 }))
    await svc.build(blocked)
    slow = true
    screens['w1:p1'] = screen('claude-scroll/p05')
    const tick = svc.build(blocked)
    let finish = () => {}
    const paging = svc.whileScrolled('w1:p1', () => new Promise<void>(r => (finish = r)))
    release()
    const [v] = await tick
    expect(v?.inbox?.options.length).toBeGreaterThan(0)
    finish()
    await paging
  })

  test('working agents show activity; queued Codex questions', async () => {
    const { svc } = service({ 'w1:p1': screen('codex-async-pending') })
    const [v] = await svc.build(snapshot(agent({ agent: 'codex', agent_status: 'working' })))
    expect(v?.activity).toBe('Working (12s • esc to interrupt)')
    expect(v?.inbox).toMatchObject({ reason: 'question', source: 'asks', asks: 2 })
  })

  test('ack hides the finished turn until the next one; snooze is reported', async () => {
    const { svc, tick } = service({ 'w1:p1': screen('claude-idle-spoof') })
    const done = agent({ agent_status: 'done' })
    expect((await svc.build(snapshot(done)))[0]?.inbox?.reason).toBe('question')
    svc.snooze(done, 10)
    expect((await svc.build(snapshot(done)))[0]?.inbox?.snoozedUntil).toBe(T + 600_000)
    svc.ack(done)
    expect((await svc.build(snapshot(done)))[0]?.inbox).toBeNull()
    tick(1000)
    const next = agent({ agent_status: 'done', completion_seq: 2, state_change_seq: 3 })
    expect((await svc.build(snapshot(next)))[0]?.inbox?.reason).toBe('question')
  })

  test('unack shows the acked turn again', async () => {
    const { svc } = service({ 'w1:p1': screen('claude-idle-spoof') })
    const done = agent({ agent_status: 'done' })
    svc.ack(done)
    expect((await svc.build(snapshot(done)))[0]?.inbox).toBeNull()
    svc.unack('w1:p1')
    expect((await svc.build(snapshot(done)))[0]?.inbox?.reason).toBe('question')
  })

  test('an acked dialog does not hide a later dialog in the same turn', async () => {
    const { svc } = service({ 'w1:p1': screen('claude-permission') })
    const blocked = agent({ agent_status: 'blocked', state_change_seq: 2 })
    svc.ack(blocked)
    expect((await svc.build(snapshot(blocked)))[0]?.inbox).toBeNull()
    await svc.build(snapshot(agent({ agent_status: 'working', state_change_seq: 3 })))
    const again = agent({ agent_status: 'blocked', state_change_seq: 4 })
    expect((await svc.build(snapshot(again)))[0]?.inbox).toMatchObject({ reason: 'permission', source: 'dialog' })
  })

  test('without a transcript, the reply is the last rows of the visible screen, never history', async () => {
    const screens = { 'w1:p1': 'some output\n\nlast line on screen\n' }
    const { svc, tick } = service(screens, { locateTranscript: async () => null })
    const done = agent({ agent_status: 'done' })
    const [v] = await svc.build(snapshot(done))
    expect(v?.inbox).toMatchObject({ reason: 'done', source: 'screen', message: 'some output\nlast line on screen' })
    screens['w1:p1'] = 'newer output\n'
    tick(5000)
    const [w] = await svc.build(snapshot(done))
    expect(w?.inbox).toMatchObject({ source: 'screen', message: 'newer output' })
  })

  test('a transcript reply is cached per state until invalidated', async () => {
    const { svc, io, tick } = service({ 'w1:p1': screen('claude-idle-spoof') })
    const done = agent({ agent_status: 'done' })
    await svc.build(snapshot(done))
    tick(60_000)
    await svc.build(snapshot(done))
    expect(io.transcriptReads).toBe(1)
    svc.invalidate('w1:p1')
    await svc.build(snapshot(done))
    expect(io.transcriptReads).toBe(2)
  })

  test('a menu the user opened while idle', async () => {
    const { svc } = service({ 'w1:p1': screen('claude-model-menu') })
    const [v] = await svc.build(snapshot(agent({})))
    expect(v?.inbox).toMatchObject({ reason: 'choice', source: 'menu' })
  })

  test("Codex's /resume picker is a menu the user opened, even while herdr reports it blocked", async () => {
    const { svc } = service({ 'w1:p1': screen('codex-resume-picker') })
    const [v] = await svc.build(snapshot(agent({ agent: 'codex', agent_status: 'blocked' })))
    expect(v?.inbox).toMatchObject({ reason: 'choice', source: 'menu', question: 'Resume a previous session' })
  })

  test('tells the rollout locator about every live Codex pane, working ones included', async () => {
    const { svc, io } = service({})
    await svc.build(snapshot(agent({ agent: 'codex', agent_status: 'working', foreground_cwd: '/home/alice/x' })))
    expect(io.live).toEqual([[{ pane: 'w1:p1', cwd: '/home/alice/x' }]])
  })

  test('I/O failures degrade to empty values', async () => {
    const { svc } = service(
      {},
      {
        readScreen: () => Promise.reject(new Error('herdr down')),
        locateTranscript: () => Promise.reject(new Error('fs')),
        branchStatus: () => Promise.reject(new Error('git')),
      },
    )
    const [v] = await svc.build(snapshot(agent({ agent_status: 'done' })))
    expect(v).toMatchObject({ branch: null, ctx: null, inbox: { reason: 'done', source: 'screen', message: '' } })
  })
})

describe('InboxService dialog episodes', () => {
  const blocked = (seq: number) => snapshot(agent({ agent_status: 'blocked', state_change_seq: seq }))
  const episodeOf = async (svc: InboxService, snap: Snapshot) => (await svc.build(snap))[0]?.inbox?.episode ?? ''

  test('one dialog keeps its episode from tick to tick', async () => {
    const { svc } = service({ 'w1:p1': screen('claude-scroll/p00') })
    const first = await episodeOf(svc, blocked(10))
    expect(first).not.toBe('')
    expect(await episodeOf(svc, blocked(10))).toBe(first)
    expect(svc.dialog('w1:p1')).toMatchObject({ episode: first, reason: 'permission' })
  })

  test('the same-looking prompt after herdr saw the agent leave it is another episode', async () => {
    // Recreating GUIDE.md with another heading: same last rows, same question, new proposal.
    const { svc } = service({ 'w1:p1': screen('claude-scroll/p00') })
    const first = await episodeOf(svc, blocked(10))
    const second = await episodeOf(svc, blocked(14))
    expect(second).not.toBe('')
    expect(second).not.toBe(first)
  })

  test('herdr may report two prompts in a row as one blocked spell: anything typed ends the episode', async () => {
    const { svc } = service({ 'w1:p1': screen('claude-scroll/p00') })
    const first = await episodeOf(svc, blocked(10))
    svc.input('w1:p1')
    const second = await episodeOf(svc, blocked(10))
    expect(second).not.toBe(first)
    expect(await episodeOf(svc, blocked(10))).toBe(second)
  })

  test('a dialog that asks something else is another episode', async () => {
    const screens: Record<string, string> = { 'w1:p1': screen('claude-scroll/p00') }
    const { svc } = service(screens)
    const first = await episodeOf(svc, blocked(10))
    screens['w1:p1'] = screen('claude-permission')
    expect(await episodeOf(svc, blocked(10))).not.toBe(first)
  })

  test('paging the view (blocked, done, blocked again) keeps the episode, for a while only', async () => {
    const { svc, tick } = service({ 'w1:p1': screen('claude-scroll/p00') })
    const first = await episodeOf(svc, blocked(10))
    await svc.whileScrolled('w1:p1', async () => {})
    tick(2500)
    // herdr still calls it done after the view settled, then blocked under a new seq.
    expect(await episodeOf(svc, snapshot(agent({ agent_status: 'done', state_change_seq: 11 })))).toBe('')
    expect(await episodeOf(svc, blocked(12))).toBe(first)
    tick(20_000)
    expect(await episodeOf(svc, blocked(15))).not.toBe(first)
  })

  test('an answer sent while the view was paged is not bridged', async () => {
    const { svc, tick } = service({ 'w1:p1': screen('claude-scroll/p00') })
    const first = await episodeOf(svc, blocked(10))
    await svc.whileScrolled('w1:p1', async () => svc.input('w1:p1'))
    tick(2500)
    expect(await episodeOf(svc, blocked(12))).not.toBe(first)
  })

  test('the agent leaving the dialog ends the episode', async () => {
    const { svc } = service({ 'w1:p1': screen('claude-scroll/p00') })
    await episodeOf(svc, blocked(10))
    await svc.build(snapshot(agent({ agent_status: 'working', state_change_seq: 11 })))
    expect(svc.dialog('w1:p1')).toBeNull()
  })

  test('revealOnce reads once per episode, keeps no failure, and nothing for an episode that is over', async () => {
    const { svc } = service({ 'w1:p1': screen('claude-scroll/p00') })
    const first = await episodeOf(svc, blocked(10))
    const question = svc.dialog('w1:p1')?.question ?? ''
    let reads = 0
    const read = async () => `proposal ${++reads}`
    const [a, b] = await Promise.all([
      svc.revealOnce('w1:p1', first, question, read),
      svc.revealOnce('w1:p1', first, question, read),
    ])
    expect([a, b, reads]).toEqual(['proposal 1', 'proposal 1', 1])
    expect(await svc.revealOnce('w1:p1', first, question, read)).toBe('proposal 1')

    const second = await episodeOf(svc, blocked(14))
    expect(svc.revealOnce('w1:p1', first, question, read)).toBeNull()
    expect(await svc.revealOnce('w1:p1', second, question, read)).toBe('proposal 2')

    const third = await episodeOf(svc, blocked(20))
    expect(await svc.revealOnce('w1:p1', third, question, async () => null)).toBeNull()
    await expect(
      svc.revealOnce('w1:p1', third, question, async () => {
        throw new Error('herdr down')
      }),
    ).rejects.toThrow('herdr down')
    expect(await svc.revealOnce('w1:p1', third, question, read)).toBe('proposal 3')
  })
})
