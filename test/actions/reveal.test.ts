// The approval card's "whole change" through the real action handler and inbox: two Claude prompts that end on the
// same rows and ask the same question (GUIDE.md recreated with another heading) are two episodes, and what was read
// for the first is never returned for the second.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ActionContext, dispatch } from '../../src/actions/index.ts'
import type { Agent, Snapshot } from '../../src/herdr.ts'
import { InboxService, InboxStore } from '../../src/inbox/index.ts'
import { KeyedMutex } from '../../src/lib/mutex.ts'
import { screen } from '../tui/fixtures.ts'

const PANE = 'w1:p1'

function setup() {
  let now = 1_800_000_000_000
  let snap: Snapshot
  const blocked = (seq: number): Snapshot => {
    const agent: Agent = {
      pane_id: PANE,
      tab_id: 'w1:t1',
      workspace_id: 'w1',
      cwd: '/home/alice/project',
      agent: 'claude',
      agent_status: 'blocked',
      state_change_seq: seq,
    }
    return { workspaces: [], tabs: [], panes: [agent], agents: [agent], layouts: [] }
  }
  const inbox = new InboxService(new InboxStore(join(mkdtempSync(join(tmpdir(), 'reveal-')), 'state.json')), {
    readScreen: async () => screen('claude-scroll/p00'),
    locateTranscript: async () => null,
    lastReply: () => null,
    branchStatus: async () => null,
    liveCodexPanes: () => {},
    now: () => now,
  })
  // What the terminal would show if paged up: the proposal of the prompt on screen now.
  const terminal = { proposal: '# Example Task Titles', reads: 0 }
  const ctx = {
    hub: { agent: (pane: string) => (pane === PANE ? snap.agents[0] : null) ?? null },
    inbox,
    locks: new KeyedMutex(),
    tui: {
      revealDialog: async () => {
        terminal.reads++
        await Bun.sleep(5)
        return terminal.proposal
      },
      chooseOption: async () => {},
    },
  } as unknown as ActionContext
  const tick = async (seq: number, status: Agent['agent_status'] = 'blocked') => {
    snap = blocked(seq)
    if (snap.agents[0]) snap.agents[0].agent_status = status
    const [view] = await inbox.build(snap)
    return { episode: view?.inbox?.episode ?? '', question: view?.inbox?.question ?? '' }
  }
  const reveal = (shown: { episode: string; question: string }) =>
    dispatch(ctx, { op: 'revealDialog', pane: PANE, ...shown }) as Promise<{ text: string; episode: string }>
  return { tick, reveal, terminal, run: (body: object) => dispatch(ctx, body), later: (ms: number) => (now += ms) }
}

describe('revealed proposals belong to one permission episode', () => {
  test('a recreated file with the same last rows and question shows its own heading', async () => {
    const { tick, reveal, terminal, later } = setup()
    const first = await tick(10)
    // An existing browser and a fresh one ask at once: the view is paged once.
    const [a, b] = await Promise.all([reveal(first), reveal(first)])
    expect(a).toEqual({ text: '# Example Task Titles', episode: first.episode })
    expect(b).toEqual(a)
    expect(terminal.reads).toBe(1)

    // Approved in the terminal; Claude proposes the same file again, headed differently.
    terminal.proposal = '# Revised Task Titles'
    later(2500)
    await tick(12, 'working')
    const second = await tick(14)
    expect(second.question).toBe(first.question)
    expect(second.episode).not.toBe(first.episode)
    // The existing browser still asks with the episode it showed: refused, never the old text.
    await expect(reveal(first)).rejects.toMatchObject({ code: 'stale_dialog' })
    // Both browsers asking for the episode on screen read the current proposal.
    expect(await reveal(second)).toEqual({ text: '# Revised Task Titles', episode: second.episode })
    expect(await reveal(second)).toEqual({ text: '# Revised Task Titles', episode: second.episode })
    expect(terminal.reads).toBe(2)
  })

  test('answered from the web and followed by an identical prompt in the same blocked spell', async () => {
    const { tick, reveal, terminal, run, later } = setup()
    const first = await tick(10)
    await reveal(first)
    await run({ op: 'option', pane: PANE, key: '1', label: 'Yes', question: first.question })
    terminal.proposal = '# Revised Task Titles'
    later(2500)
    // herdr never reported the agent leaving the dialog: same state_change_seq.
    const second = await tick(10)
    expect(second.episode).not.toBe(first.episode)
    expect((await reveal(second)).text).toBe('# Revised Task Titles')
  })

  test('the read itself, which makes herdr report done and blocked again, does not start a new episode', async () => {
    const { tick, reveal, terminal, later } = setup()
    const first = await tick(10)
    await reveal(first)
    later(2500)
    const after = await tick(12)
    expect(after.episode).toBe(first.episode)
    expect((await reveal(after)).text).toBe('# Example Task Titles')
    expect(terminal.reads).toBe(1)
  })

  test('without a working tick in between, the next prompt is still a new episode once the paging is over', async () => {
    const { tick, reveal, terminal, later } = setup()
    const first = await tick(10)
    await reveal(first)
    later(2500)
    expect((await tick(12)).episode).toBe(first.episode)
    // herdr's done → blocked of the paging has been seen; the next seq change is an answer.
    terminal.proposal = '# Revised Task Titles'
    const second = await tick(16)
    expect(second.episode).not.toBe(first.episode)
    expect((await reveal(second)).text).toBe('# Revised Task Titles')
    // And when herdr's blocked again never showed, the bridge does not outlast a few seconds.
    const third = await tick(16)
    await reveal(third)
    later(8000)
    expect((await tick(20)).episode).not.toBe(third.episode)
  })
})
