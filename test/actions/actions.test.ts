import { describe, expect, test } from 'bun:test'
import { basename } from 'node:path'
import { ForkError } from '../../plugin/quick-fork/fork.ts'
import { type ActionContext, dispatch } from '../../src/actions/index.ts'
import { agentCommand, rideArgv } from '../../src/actions/session.ts'
import type { Agent, Snapshot } from '../../src/herdr.ts'
import { TtlCache } from '../../src/lib/cache.ts'
import { KeyedMutex } from '../../src/lib/mutex.ts'
import type { Turn } from '../../src/protocol.ts'
import { UserError, errorResponse } from '../../src/server/http.ts'
import { TuiError } from '../../src/tui/index.ts'
import { fakeSnapshot } from '../server/fake.ts'

const ROLLOUT =
  '/home/alice/.codex/sessions/2026/01/02/rollout-2026-01-02T03-04-05-00000000-0000-4000-8000-00000000000c.jsonl'
const OTHER_ROLLOUT =
  '/home/alice/.codex/sessions/2026/01/02/rollout-2026-01-02T05-00-00-00000000-0000-4000-8000-00000000000d.jsonl'

interface Fakes {
  /** chooseOption waits for this before it returns. */
  gate?: Promise<void>
  lastTurn?: Turn | null
  stops?: boolean
  /** What the agent's input box holds, read after read (the last one repeats). */
  drafts?: string[]
  /** The dialog the inbox saw on each pane. */
  dialogs?: Record<string, { episode: string; reason: string; question: string }>
  /** showInputBox finds a panel over the input box that does not close. */
  noInputBox?: boolean
}

function setup(snap: Snapshot = fakeSnapshot(), fork?: ActionContext['fork'], fakes: Fakes = {}) {
  const calls: unknown[][] = []
  const inputs: string[] = []
  let draftReads = 0
  const dismissed: string[] = []
  const queueOps: unknown[][] = []
  const log =
    (name: string, ret?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return ret
    }
  let refreshes = 0
  const find = <T>(list: T[], key: keyof T, id: string) => list.find(x => x[key] === id) ?? null
  const ctx: ActionContext = {
    hub: {
      snapshot: snap,
      agent: id => find(snap.agents, 'pane_id', id),
      pane: id => find(snap.panes, 'pane_id', id),
      tab: id => find(snap.tabs, 'tab_id', id),
      workspace: id => find(snap.workspaces, 'workspace_id', id),
      refresh: async () => void refreshes++,
    },
    herdr: {
      sendKeys: log('sendKeys'),
      prompt: log('prompt'),
      focusAgent: log('focusAgent'),
      waitAgent: async (...args) => {
        calls.push(['waitAgent', ...args])
        return fakes.stops ?? true
      },
      rename: log('rename'),
      createTab: async (...args) => {
        calls.push(['createTab', ...args])
        return 'w1:p7'
      },
      createWorkspace: async (...args) => {
        calls.push(['createWorkspace', ...args])
        return 'w9:p1'
      },
      renameWorkspace: log('renameWorkspace'),
      closeTab: log('closeTab'),
      runInPane: log('runInPane'),
    },
    inbox: {
      ack: (a: Agent) => void calls.push(['ack', a.pane_id]),
      unack: pane => void calls.push(['unack', pane]),
      snooze: (a: Agent, minutes) => void calls.push(['snooze', a.pane_id, minutes]),
      invalidate: pane => void calls.push(['invalidate', pane]),
      input: pane => void inputs.push(pane),
      dialog: pane => fakes.dialogs?.[pane] ?? null,
      revealOnce: (pane, episode, _question, read) => (fakes.dialogs?.[pane]?.episode === episode ? read() : null),
      whileScrolled: (pane, fn) => {
        calls.push(['whileScrolled', pane])
        return fn()
      },
    },
    tui: {
      chooseOption: async (...args) => {
        calls.push(['chooseOption', ...args])
        if (fakes.gate) {
          await fakes.gate
          calls.push(['chosen'])
        }
      },
      answerAsyncQuestion: log('answerAsyncQuestion') as ActionContext['tui']['answerAsyncQuestion'],
      prepareReply: log('prepareReply') as ActionContext['tui']['prepareReply'],
      showInputBox: async (...args) => {
        calls.push(['showInputBox', ...args])
        if (fakes.noInputBox) throw new TuiError('no_input_box', 'covered')
      },
      interruptAndRestore: async (...args) => {
        calls.push(['interruptAndRestore', ...args])
        return { restored: true }
      },
      interrupt: log('interrupt') as ActionContext['tui']['interrupt'],
      clearInput: log('clearInput') as ActionContext['tui']['clearInput'],
      revealDialog: async (...args) => {
        calls.push(['revealDialog', ...args])
        return 'Create file\na.js'
      },
      inputDraft: async pane => {
        const drafts = fakes.drafts ?? ['']
        const draft = drafts[Math.min(draftReads++, drafts.length - 1)] ?? ''
        calls.push(['inputDraft', pane, draft])
        return draft
      },
      discardDraft: log('discardDraft') as ActionContext['tui']['discardDraft'],
    },
    firstMessages: {
      add: (pane, text) => void calls.push(['firstMessage', pane, text]),
      dismiss: pane => void dismissed.push(pane),
    },
    replyQueues: {
      add: (pane, session, text) => {
        if (text === 'one too many') throw new Error('At most 20 messages wait for one agent')
        queueOps.push(['add', pane, session, text])
        return 'q1'
      },
      remove: (pane, id) => {
        queueOps.push(['remove', pane, id])
        return id === 'q1'
      },
      pause: pane => void queueOps.push(['pause', pane]),
      resume: pane => void queueOps.push(['resume', pane]),
    },
    locks: new KeyedMutex(),
    agents: {
      locateTranscript: async () => ROLLOUT,
      codexSessionId: () => '00000000-0000-4000-8000-00000000000c',
      isCodexRollout: p => p.startsWith('/home/alice/.codex/sessions/') && !p.includes('..'),
      lastTurn: (...args) => {
        calls.push(['lastTurn', ...args])
        return fakes.lastTurn ?? null
      },
      pinCodexSession: async (...args) => {
        calls.push(['pinCodexSession', ...args])
        return args[2] !== OTHER_ROLLOUT
      },
    },
    fork:
      fork ??
      (async o => {
        calls.push(['fork', o])
        return { pane: 'w1:p8' }
      }),
    requests: new TtlCache<string, object>(30_000),
    dirs: {
      isDir: path => !path.includes('missing'),
      record: dir => void calls.push(['recordDir', dir]),
    },
    home: '/home/alice',
  }
  const run = (body: unknown) => dispatch(ctx, body)
  const fails = async (body: unknown, code: string) => {
    const err = await run(body).catch(e => e)
    expect(err).toBeInstanceOf(UserError)
    expect((err as UserError).code).toBe(code)
    return err as UserError
  }
  return { run, fails, calls, inputs, dismissed, queueOps, refreshes: () => refreshes }
}

describe('dispatch', () => {
  test('rejects unknown ops and non-objects', async () => {
    const { fails } = setup()
    await fails({ op: 'exec' }, 'unknown_op')
    await fails({ op: 'toString' }, 'unknown_op')
    await fails(null, 'unknown_op')
    await fails([], 'unknown_op')
  })

  test('validates field types before touching herdr', async () => {
    const { fails, calls } = setup()
    await fails({ op: 'keys', pane: 'w1:p1', keys: 'esc' }, 'bad_request')
    await fails({ op: 'keys', pane: 'w1:p1', keys: [] }, 'bad_request')
    await fails({ op: 'keys', pane: 'w1:p1', keys: ['--help'] }, 'bad_request')
    await fails({ op: 'keys', pane: 'w1:p1', keys: [1] }, 'bad_request')
    await fails({ op: 'reply', pane: 'w1:p1', text: 42 }, 'bad_request')
    await fails({ op: 'reply', pane: '-w1', text: 'hi' }, 'bad_request')
    await fails({ op: 'snooze', pane: 'w1:p1', minutes: 0 }, 'bad_request')
    await fails({ op: 'snooze', pane: 'w1:p1', minutes: '30' }, 'bad_request')
    await fails({ op: 'fork', pane: 'w1:p1', mode: 'left' }, 'bad_request')
    await fails({ op: 'option', pane: 'w1:p1', key: '-1', label: 'Yes' }, 'bad_request')
    await fails({ op: 'option', pane: 'w1:p1', key: 'nav:1' }, 'bad_request')
    expect(calls).toEqual([])
  })

  test('validates ids against the snapshot', async () => {
    const { fails } = setup()
    await fails({ op: 'reply', pane: 'w9:p9', text: 'hi' }, 'no_agent')
    await fails({ op: 'reply', pane: 'w1:p2', text: 'hi' }, 'no_agent')
    await fails({ op: 'keys', pane: 'w9:p9', keys: ['esc'] }, 'unknown_pane')
    await fails({ op: 'closeTab', tab: 'w9:t9' }, 'unknown_tab')
    await fails({ op: 'new', workspace: 'w9' }, 'unknown_workspace')
  })
})

describe('session', () => {
  test('new agent: quoted argv with -- before the first message, in the workspace folder', async () => {
    const { run, calls } = setup()
    const r = await run({
      op: 'new',
      workspace: 'w1',
      agent: 'claude',
      model: 'opus[1m]',
      effort: 'high',
      text: ' --dangerously-skip-permissions ',
    })
    expect(r).toEqual({ pane: 'w1:p7' })
    expect(calls).toEqual([
      ['createTab', 'w1', '/home/alice/project/sub', 'claude'],
      ['runInPane', 'w1:p7', "claude --model 'opus[1m]' --effort high -- --dangerously-skip-permissions"],
    ])
  })

  test('new codex agent with reasoning effort', () => {
    expect(agentCommand('codex', 'gpt-5', 'high', '')).toEqual([
      'codex',
      '-m',
      'gpt-5',
      '-c',
      'model_reasoning_effort="high"',
    ])
  })

  test('slash commands and multi-line text wait for the agent instead of riding argv', async () => {
    const { run, calls } = setup()
    await run({ op: 'new', workspace: 'w1', agent: 'codex', cwd: '~/src', text: '/goal x' })
    await run({ op: 'new', workspace: 'w1', agent: 'claude', text: 'line 1\r\nline 2' })
    expect(calls).toEqual([
      ['createTab', 'w1', '/home/alice/src', 'codex'],
      ['recordDir', '/home/alice/src'],
      ['runInPane', 'w1:p7', 'codex'],
      ['firstMessage', 'w1:p7', '/goal x'],
      ['createTab', 'w1', '/home/alice/project/sub', 'claude'],
      ['runInPane', 'w1:p7', 'claude'],
      ['firstMessage', 'w1:p7', 'line 1\nline 2'],
    ])
    expect(rideArgv('fix the bug')).toBe(true)
  })

  test('new shell tab runs nothing; unknown agents, bad model tokens and relative cwds are refused', async () => {
    const { run, fails, calls } = setup()
    await run({ op: 'new', workspace: 'w1', cwd: '/tmp/x' })
    expect(calls).toEqual([
      ['createTab', 'w1', '/tmp/x', 'shell'],
      ['recordDir', '/tmp/x'],
    ])
    await fails({ op: 'new', workspace: 'w1', agent: 'claude', cwd: '/tmp/missing' }, 'bad_cwd')
    expect(calls).toHaveLength(2)
    await fails({ op: 'new', workspace: 'w1', agent: 'claude', model: '--x' }, 'bad_request')
    await fails({ op: 'new', workspace: 'w1', agent: 'claude', model: 'a b' }, 'bad_request')
    await fails({ op: 'new', workspace: 'w1', cwd: 'relative' }, 'bad_request')
    await fails({ op: 'new', workspace: 'w1', agent: 'gemini' }, 'bad_request')
    await fails({ op: 'new', workspace: 'w1', agent: 'shell' }, 'bad_request')
  })

  test('a new workspace in the folder, named as asked, runs the agent in its first pane', async () => {
    const { run, fails, calls } = setup()
    expect(await run({ op: 'new', newWorkspace: ' x ', agent: 'claude', cwd: '/tmp/x', text: 'hi' })).toEqual({
      pane: 'w9:p1',
    })
    expect(calls).toEqual([
      ['createWorkspace', '/tmp/x', 'x'],
      ['recordDir', '/tmp/x'],
      ['runInPane', 'w9:p1', 'claude -- hi'],
    ])
    await fails({ op: 'new', agent: 'claude', cwd: '/tmp/x' }, 'bad_workspace')
    await fails({ op: 'new', workspace: 'w1', newWorkspace: 'x', cwd: '/tmp/x' }, 'bad_workspace')
    await fails({ op: 'new', newWorkspace: '-x', cwd: '/tmp/x' }, 'bad_request')
    await fails({ op: 'new', newWorkspace: 'a\nb', cwd: '/tmp/x' }, 'bad_request')
    await fails({ op: 'new', newWorkspace: 'x', cwd: '/tmp/missing' }, 'bad_cwd')
    expect(calls.filter(c => c[0] === 'createWorkspace')).toHaveLength(1)
  })

  test('renameWorkspace renames a known workspace to a non-empty label', async () => {
    const { run, fails, calls } = setup()
    await run({ op: 'renameWorkspace', workspace: 'w1', label: ' 发 cli ' })
    expect(calls).toEqual([['renameWorkspace', 'w1', '发 cli']])
    await fails({ op: 'renameWorkspace', workspace: 'w1', label: '  ' }, 'invalid_name')
    await fails({ op: 'renameWorkspace', workspace: 'w404', label: 'x' }, 'unknown_workspace')
    await fails({ op: 'renameWorkspace', workspace: 'w1', label: '--help' }, 'bad_request')
  })

  test('a repeated request id creates one tab and returns the first result', async () => {
    const { run, fails, calls } = setup()
    const body = { op: 'new', workspace: 'w1', cwd: '/tmp/x', request: 'k1-a' }
    // A double click: the second arrives while the first is still creating the tab.
    const [a, b] = await Promise.all([run(body), run(body)])
    expect(a).toEqual({ pane: 'w1:p7' })
    expect(b).toEqual(a)
    // A retry after the answer was lost.
    expect(await run(body)).toEqual(a)
    expect(calls.filter(c => c[0] === 'createTab')).toHaveLength(1)
    await run({ ...body, request: 'k2-b' })
    await run({ op: 'new', workspace: 'w1', cwd: '/tmp/x' })
    expect(calls.filter(c => c[0] === 'createTab')).toHaveLength(3)
    await fails({ ...body, request: 'a b' }, 'bad_request')
  })

  test('a failed request is not remembered, so a retry runs again', async () => {
    const { run, fails, calls } = setup()
    await fails({ op: 'new', workspace: 'w1', cwd: '/tmp/missing', request: 'k3' }, 'bad_cwd')
    await fails({ op: 'new', workspace: 'w1', cwd: '/tmp/missing', request: 'k3' }, 'bad_cwd')
    await run({ op: 'new', workspace: 'w1', cwd: '/tmp/x', request: 'k4' })
    expect(calls.filter(c => c[0] === 'createTab')).toHaveLength(1)
  })

  test('a repeated fork request forks once', async () => {
    const { run, calls } = setup()
    const body = { op: 'fork', pane: 'w1:p1', mode: 'tab', request: 'f1' }
    const results = await Promise.all([run(body), run(body)])
    expect(results).toEqual([{ pane: 'w1:p8' }, { pane: 'w1:p8' }])
    expect(calls.filter(c => c[0] === 'fork')).toHaveLength(1)
  })

  test('rename validates the name and refreshes', async () => {
    const { run, fails, calls, refreshes } = setup()
    await run({ op: 'rename', pane: 'w1:p1', name: ' reviewer ' })
    await run({ op: 'rename', pane: 'w1:p1', name: '' })
    expect(calls).toEqual([
      ['rename', 'w1:p1', 'reviewer'],
      ['rename', 'w1:p1', null],
    ])
    expect(refreshes()).toBe(2)
    await fails({ op: 'rename', pane: 'w1:p1', name: 'Bad Name' }, 'invalid_name')
  })

  test('closeTab and focus', async () => {
    const { run, calls, refreshes } = setup()
    await run({ op: 'closeTab', tab: 'w1:t1' })
    await run({ op: 'focus', pane: 'w1:p1' })
    expect(calls).toEqual([
      ['closeTab', 'w1:t1'],
      ['focusAgent', 'w1:p1'],
    ])
    expect(refreshes()).toBe(1)
  })

  test('pinSession: a Codex pane is told which of its conversations it shows', async () => {
    const { run, fails, calls } = setup()
    await run({ op: 'pinSession', pane: 'w2:p1', path: ROLLOUT })
    expect(calls).toEqual([
      ['pinCodexSession', 'w2:p1', '/home/alice/project', ROLLOUT],
      ['invalidate', 'w2:p1'],
    ])
    await fails({ op: 'pinSession', pane: 'w2:p1', path: OTHER_ROLLOUT }, 'unknown_session')
    await fails({ op: 'pinSession', pane: 'w2:p1', path: '/etc/passwd' }, 'unknown_session')
    await fails({ op: 'pinSession', pane: 'w1:p1', path: ROLLOUT }, 'not_codex')
  })
})

describe('reply', () => {
  test('a blocked agent gets its dialog cleared first', async () => {
    const { run, fails, calls } = setup()
    await run({ op: 'reply', pane: 'w1:p1', text: ' hi ' })
    await run({ op: 'reply', pane: 'w2:p1', text: 'go on' })
    expect(calls).toEqual([
      ['showInputBox', 'w1:p1', { escape: false }],
      ['inputDraft', 'w1:p1', ''],
      ['prompt', 'w1:p1', 'hi'],
      ['invalidate', 'w1:p1'],
      ['prepareReply', 'w2:p1'],
      ['showInputBox', 'w2:p1', { escape: true }],
      ['inputDraft', 'w2:p1', ''],
      ['prompt', 'w2:p1', 'go on'],
      ['invalidate', 'w2:p1'],
    ])
    await fails({ op: 'reply', pane: 'w1:p1', text: '   ' }, 'empty_text')
  })

  test('text left in the terminal input stops the send and comes back with the error', async () => {
    const { run, calls } = setup(fakeSnapshot(), undefined, { drafts: ['R5LEFT__RIGHT'] })
    const err = await run({ op: 'reply', pane: 'w1:p1', text: 'Reply only R5_WEB_ONLY.' }).catch(e => e)
    expect(err).toBeInstanceOf(TuiError)
    expect(err).toMatchObject({ code: 'terminal_draft', data: { draft: 'R5LEFT__RIGHT' } })
    expect(calls).toEqual([
      ['showInputBox', 'w1:p1', { escape: false }],
      ['inputDraft', 'w1:p1', 'R5LEFT__RIGHT'],
    ])
    // The browser shows the draft as the server sends it.
    const body = await errorResponse(err).json()
    expect(body).toMatchObject({ ok: false, code: 'terminal_draft', draft: 'R5LEFT__RIGHT' })
  })

  test('discardDraft empties the input box first when it holds the approved draft, then sends', async () => {
    const { run, calls } = setup(fakeSnapshot(), undefined, { drafts: ['R5LEFT__RIGHT'] })
    await run({ op: 'reply', pane: 'w1:p1', text: 'go', discardDraft: 'R5LEFT__RIGHT' })
    expect(calls).toEqual([
      ['showInputBox', 'w1:p1', { escape: false }],
      ['inputDraft', 'w1:p1', 'R5LEFT__RIGHT'],
      ['discardDraft', 'w1:p1'],
      ['prompt', 'w1:p1', 'go'],
      ['invalidate', 'w1:p1'],
    ])
    // Re-wrapped by the TUI: still the same draft.
    const wrapped = setup(fakeSnapshot(), undefined, { drafts: ['first line\nsecond  line'] })
    await wrapped.run({ op: 'reply', pane: 'w1:p1', text: 'go', discardDraft: 'first line second line ' })
    expect(wrapped.calls.map(c => c[0])).toEqual(['showInputBox', 'inputDraft', 'discardDraft', 'prompt', 'invalidate'])
    // Nothing to discard: sent as is.
    const empty = setup()
    await empty.run({ op: 'reply', pane: 'w1:p1', text: 'go', discardDraft: 'gone meanwhile' })
    expect(empty.calls.map(c => c[0])).toEqual(['showInputBox', 'inputDraft', 'prompt', 'invalidate'])
    // A bare yes does not say which draft was approved.
    await empty.fails({ op: 'reply', pane: 'w1:p1', text: 'go', discardDraft: true }, 'bad_request')
  })

  test('a draft edited in the terminal after it was shown is kept, and comes back to be asked again', async () => {
    const { run, calls } = setup(fakeSnapshot(), undefined, { drafts: ['R6_NEW_UNSEEN_DRAFT'] })
    const err = await run({ op: 'reply', pane: 'w1:p1', text: 'go', discardDraft: 'R6_OLD_DRAFT' }).catch(e => e)
    expect(err).toMatchObject({ code: 'terminal_draft', data: { draft: 'R6_NEW_UNSEEN_DRAFT' } })
    expect(calls).toEqual([
      ['showInputBox', 'w1:p1', { escape: false }],
      ['inputDraft', 'w1:p1', 'R6_NEW_UNSEEN_DRAFT'],
    ])
    // Text added to the approved draft is a change too.
    const longer = setup(fakeSnapshot(), undefined, { drafts: ['R6_OLD_DRAFT and more'] })
    await expect(
      longer.run({ op: 'reply', pane: 'w1:p1', text: 'go', discardDraft: 'R6_OLD_DRAFT' }),
    ).rejects.toMatchObject({ code: 'terminal_draft', data: { draft: 'R6_OLD_DRAFT and more' } })
    expect(longer.calls.map(c => c[0])).toEqual(['showInputBox', 'inputDraft'])
  })

  test('a reply to a blocked agent checks the box once the dialog is out of the way', async () => {
    const { run, calls } = setup(fakeSnapshot(), undefined, { drafts: ['half a thought'] })
    await expect(run({ op: 'reply', pane: 'w2:p1', text: 'go' })).rejects.toMatchObject({ code: 'terminal_draft' })
    expect(calls.map(c => c[0])).toEqual(['prepareReply', 'showInputBox', 'inputDraft'])
  })

  test('everything typed into an agent pane tells the inbox, before and after; reading does not', async () => {
    const dialogs = { 'w1:p1': { episode: 'e1', reason: 'permission', question: 'Do you want to create a.js?' } }
    const { run, inputs } = setup(fakeSnapshot(), undefined, { dialogs })
    await run({ op: 'reply', pane: 'w1:p1', text: 'hi' })
    await run({ op: 'keys', pane: 'w1:p2', keys: ['q'] })
    await run({ op: 'option', pane: 'w2:p1', key: '1', label: 'Yes' })
    await run({ op: 'revealDialog', pane: 'w1:p1', question: 'Do you want to create a.js?', episode: 'e1' })
    expect(inputs).toEqual(['w1:p1', 'w1:p1', 'w2:p1', 'w2:p1'])
  })

  test('interrupt restores the last message when given one', async () => {
    const { run, calls } = setup()
    expect(await run({ op: 'interrupt', pane: 'w1:p1', last: 'do it' })).toEqual({ restored: true })
    await run({ op: 'interrupt', pane: 'w1:p1' })
    expect(calls).toEqual([
      ['interruptAndRestore', 'w1:p1', 'do it'],
      ['interruptAndRestore', 'w1:p1', ''],
    ])
  })

  const turn = (text: string, steps: Turn['steps'] = []): Turn => ({
    id: '1',
    user: { type: 'user', text, images: 0, ts: 1 },
    steps,
    start: 1,
    end: 1,
  })

  test('Codex interrupt gives the message back when its turn has produced nothing yet', async () => {
    const unanswered = setup(fakeSnapshot(), undefined, { lastTurn: turn('do  it\nnow', [{ type: 'think', ts: 2 }]) })
    expect(await unanswered.run({ op: 'interrupt', pane: 'w2:p1', last: 'do it now' })).toEqual({ restored: true })
    expect(unanswered.calls).toEqual([
      ['interrupt', 'w2:p1'],
      ['lastTurn', 'codex', ROLLOUT],
    ])

    const answered = setup(fakeSnapshot(), undefined, {
      lastTurn: turn('do it now', [{ type: 'text', text: 'on it', ts: 2 }]),
    })
    expect(await answered.run({ op: 'interrupt', pane: 'w2:p1', last: 'do it now' })).toEqual({})
    const other = setup(fakeSnapshot(), undefined, { lastTurn: turn('an older message') })
    expect(await other.run({ op: 'interrupt', pane: 'w2:p1', last: 'do it now' })).toEqual({})

    const nothingSent = setup()
    expect(await nothingSent.run({ op: 'interrupt', pane: 'w2:p1' })).toEqual({})
    expect(nothingSent.calls).toEqual([['interrupt', 'w2:p1']])
  })

  test('clearGoal stops a working agent, waits for it, then types /goal clear into an empty box', async () => {
    const { run, calls } = setup()
    expect(await run({ op: 'clearGoal', pane: 'w1:p1', last: 'go' })).toEqual({ restored: true })
    expect(calls).toEqual([
      ['interruptAndRestore', 'w1:p1', 'go'],
      ['waitAgent', 'w1:p1', ['idle', 'done'], 15_000],
      ['clearInput', 'w1:p1'],
      ['prompt', 'w1:p1', '/goal clear'],
      ['invalidate', 'w1:p1'],
    ])
  })

  test('clearGoal leaves a dialog first, and types nothing when the agent does not stop', async () => {
    const blocked = setup()
    await blocked.run({ op: 'clearGoal', pane: 'w2:p1' })
    expect(blocked.calls).toEqual([
      ['prepareReply', 'w2:p1'],
      ['prompt', 'w2:p1', '/goal clear'],
      ['invalidate', 'w2:p1'],
    ])

    const stuck = setup(fakeSnapshot(), undefined, { stops: false })
    await stuck.fails({ op: 'clearGoal', pane: 'w1:p1' }, 'still_working')
    expect(stuck.calls.map(c => c[0])).toEqual(['interruptAndRestore', 'waitAgent'])

    const snap = fakeSnapshot()
    snap.agents[0]!.agent_status = 'idle'
    const idle = setup(snap)
    await idle.run({ op: 'clearGoal', pane: 'w1:p1' })
    expect(idle.calls).toEqual([
      ['prompt', 'w1:p1', '/goal clear'],
      ['invalidate', 'w1:p1'],
    ])
  })

  test('keys work on plain terminals too', async () => {
    const { run, calls } = setup()
    await run({ op: 'keys', pane: 'w1:p2', keys: ['ctrl+c', 'q', 'shift+right'] })
    await run({ op: 'keys', pane: 'w1:p1', keys: ['esc'] })
    expect(calls).toEqual([
      ['sendKeys', 'w1:p2', ['ctrl+c', 'q', 'shift+right']],
      ['sendKeys', 'w1:p1', ['esc']],
      ['invalidate', 'w1:p1'],
    ])
  })
})

describe('dialog', () => {
  test('option passes the label, the question and whether the agent is blocked', async () => {
    const { run, calls } = setup()
    await run({ op: 'option', pane: 'w2:p1', key: '2', label: 'Yes', question: 'Proceed?' })
    await run({ op: 'option', pane: 'w1:p1', key: 'nav:-2', label: 'Other', text: 'other text' })
    expect(calls).toEqual([
      ['chooseOption', 'w2:p1', { key: '2', label: 'Yes', question: 'Proceed?', text: null, blocked: true }],
      ['invalidate', 'w2:p1'],
      ['chooseOption', 'w1:p1', { key: 'nav:-2', label: 'Other', question: null, text: 'other text', blocked: false }],
      ['invalidate', 'w1:p1'],
    ])
  })

  test('key-driving actions on one pane never interleave; other panes do not wait', async () => {
    let release = () => {}
    const gate = new Promise<void>(r => {
      release = r
    })
    const { run, calls } = setup(fakeSnapshot(), undefined, { gate })
    const option = run({ op: 'option', pane: 'w2:p1', key: '1', label: 'Yes' })
    const reply = run({ op: 'reply', pane: 'w2:p1', text: 'hi' })
    await run({ op: 'keys', pane: 'w1:p2', keys: ['q'] })
    expect(calls.map(c => c[0])).toEqual(['chooseOption', 'sendKeys'])
    release()
    await Promise.all([option, reply])
    expect(calls.map(c => c[0])).toEqual([
      'chooseOption',
      'sendKeys',
      'chosen',
      'invalidate',
      'prepareReply',
      'showInputBox',
      'inputDraft',
      'prompt',
      'invalidate',
    ])
  })

  test('asyncAnswer needs an option or text', async () => {
    const { run, fails, calls } = setup()
    await fails({ op: 'asyncAnswer', pane: 'w2:p1', question: 'Q?' }, 'bad_request')
    await run({ op: 'asyncAnswer', pane: 'w2:p1', question: 'Q?', option: 'Yes' })
    expect(calls).toEqual([
      ['answerAsyncQuestion', 'w2:p1', 'Q?', { option: 'Yes', text: null }],
      ['invalidate', 'w2:p1'],
    ])
  })
})

describe('revealDialog', () => {
  const question = 'Do you want to create a.js?'
  const dialogs = { 'w1:p1': { episode: 'e1', reason: 'permission', question } }

  test('reads a Claude permission dialog of the current episode under the pane lock', async () => {
    const { run, calls } = setup(fakeSnapshot(), undefined, { dialogs })
    expect(await run({ op: 'revealDialog', pane: 'w1:p1', question, episode: 'e1' })).toEqual({
      text: 'Create file\na.js',
      episode: 'e1',
    })
    expect(calls).toEqual([
      ['whileScrolled', 'w1:p1'],
      ['revealDialog', 'w1:p1', question],
    ])
  })

  test('is refused for another episode, another dialog, and Codex, without touching the pane', async () => {
    const { fails, calls } = setup(fakeSnapshot(), undefined, {
      dialogs: { ...dialogs, 'w2:p1': { episode: 'e2', reason: 'permission', question: 'Proceed?' } },
    })
    await fails({ op: 'revealDialog', pane: 'w1:p1', question, episode: 'e0' }, 'stale_dialog')
    await fails({ op: 'revealDialog', pane: 'w1:p1', question }, 'bad_request')
    await fails({ op: 'revealDialog', pane: 'w2:p1', question: 'Proceed?', episode: 'e2' }, 'unsupported')
    const choice = setup(fakeSnapshot(), undefined, {
      dialogs: { 'w1:p1': { episode: 'e3', reason: 'choice', question: 'Which one?' } },
    })
    await choice.fails({ op: 'revealDialog', pane: 'w1:p1', question: 'Which one?', episode: 'e3' }, 'not_permission')
    const none = setup()
    await none.fails({ op: 'revealDialog', pane: 'w1:p1', question, episode: 'e1' }, 'stale_dialog')
    expect([...calls, ...choice.calls, ...none.calls]).toEqual([])
  })
})

describe('first messages', () => {
  test('dismissFirstMessage drops it and refreshes; a delivered reply drops it too', async () => {
    const { run, dismissed, refreshes } = setup()
    await run({ op: 'dismissFirstMessage', pane: 'w1:p7' })
    expect([dismissed, refreshes()]).toEqual([['w1:p7'], 1])
    await run({ op: 'reply', pane: 'w1:p1', text: '/goal ship it' })
    expect(dismissed).toEqual(['w1:p7', 'w1:p1'])
  })
})

describe('inbox', () => {
  test('ack, seen (not while blocked), unack and snooze', async () => {
    const { run, calls, refreshes } = setup()
    await run({ op: 'ack', pane: 'w1:p1' })
    await run({ op: 'seen', pane: 'w2:p1' })
    await run({ op: 'seen', pane: 'w1:p1' })
    await run({ op: 'unack', pane: 'w1:p1' })
    await run({ op: 'snooze', pane: 'w1:p1' })
    await run({ op: 'snooze', pane: 'w1:p1', minutes: 60 })
    expect(calls).toEqual([
      ['ack', 'w1:p1'],
      ['ack', 'w1:p1'],
      ['unack', 'w1:p1'],
      ['snooze', 'w1:p1', 30],
      ['snooze', 'w1:p1', 60],
    ])
    expect(refreshes()).toBe(6)
  })

  test('a reply read here that herdr calls done is focused in herdr, which is all that clears it there', async () => {
    const snap = fakeSnapshot()
    snap.agents[0]!.agent_status = 'done'
    const { run, calls } = setup(snap)
    await run({ op: 'seen', pane: 'w1:p1' })
    expect(calls).toEqual([
      ['ack', 'w1:p1'],
      ['focusAgent', 'w1:p1'],
    ])
  })
})

describe('fork', () => {
  test('claude: validates the message uuid', async () => {
    const { run, fails, calls } = setup()
    const at = '00000000-0000-4000-8000-0000000000aa'
    expect(await run({ op: 'fork', pane: 'w1:p1', mode: 'right', at })).toEqual({ pane: 'w1:p8' })
    expect(calls).toEqual([['fork', { pane: 'w1:p1', mode: 'right', session: undefined, at }]])
    await fails({ op: 'fork', pane: 'w1:p1', at: `${ROLLOUT}#100` }, 'invalid_fork_point')
  })

  test('codex: passes the rollout session, or only the fork point, which must stay under CODEX_HOME', async () => {
    const { run, fails, calls } = setup()
    await run({ op: 'fork', pane: 'w2:p1' })
    await run({ op: 'fork', pane: 'w2:p1', at: `${ROLLOUT}#4096` })
    expect(calls).toEqual([
      ['fork', { pane: 'w2:p1', mode: 'tab', session: '00000000-0000-4000-8000-00000000000c', at: undefined }],
      ['fork', { pane: 'w2:p1', mode: 'tab', session: undefined, at: `${ROLLOUT}#4096` }],
    ])
    await fails({ op: 'fork', pane: 'w2:p1', at: '/etc/passwd.jsonl#1' }, 'invalid_fork_point')
    await fails({ op: 'fork', pane: 'w2:p1', at: '/home/alice/.codex/sessions/../x.jsonl#1' }, 'invalid_fork_point')
    await fails({ op: 'fork', pane: 'w2:p1', at: `${ROLLOUT}` }, 'invalid_fork_point')
  })

  test('maps fork errors to codes and statuses', async () => {
    const failWith = (err: Error) =>
      setup(fakeSnapshot(), async () => {
        throw err
      })
    const notFound = await failWith(new ForkError('no transcript', 'not_found')).fails(
      { op: 'fork', pane: 'w1:p1' },
      'not_found',
    )
    expect(notFound.status).toBe(400)
    const herdr = await failWith(new ForkError('herdr: boom', 'herdr')).fails({ op: 'fork', pane: 'w1:p1' }, 'herdr')
    expect(herdr.status).toBe(502)
    const other = await failWith(new Error('disk full')).fails({ op: 'fork', pane: 'w1:p1' }, 'fork_failed')
    expect(other.status).toBe(500)
    expect(other.message).toBe('disk full')
  })
})

test('a reply that finds the input box covered is not typed anywhere', async () => {
  const { run, calls } = setup(fakeSnapshot(), undefined, { noInputBox: true })
  await expect(run({ op: 'reply', pane: 'w1:p1', text: 'lost?' })).rejects.toMatchObject({ code: 'no_input_box' })
  expect(calls.map(c => c[0])).toEqual(['showInputBox'])
})

test('closePanel brings the input box back, with Esc unless the agent works', async () => {
  const { run, calls } = setup()
  await run({ op: 'closePanel', pane: 'w2:p1' })
  await run({ op: 'closePanel', pane: 'w1:p1' })
  expect(calls).toEqual([
    ['showInputBox', 'w2:p1', { escape: true }],
    ['invalidate', 'w2:p1'],
    ['showInputBox', 'w1:p1', { escape: false }],
    ['invalidate', 'w1:p1'],
  ])
})

test('cycleMode presses Shift+Tab only with the input box on screen, never closing what covers it', async () => {
  const { run, calls } = setup()
  await run({ op: 'cycleMode', pane: 'w1:p1' })
  expect(calls).toEqual([
    ['showInputBox', 'w1:p1', { escape: false }],
    ['sendKeys', 'w1:p1', ['shift+tab']],
    ['invalidate', 'w1:p1'],
  ])
  const covered = setup(fakeSnapshot(), undefined, { noInputBox: true })
  await expect(covered.run({ op: 'cycleMode', pane: 'w1:p1' })).rejects.toMatchObject({ code: 'no_input_box' })
  expect(covered.calls.map(c => c[0])).toEqual(['showInputBox'])
})

describe('reply queue', () => {
  test('queues for the conversation the pane shows, and says when the queue is full', async () => {
    const { run, fails, queueOps } = setup()
    expect(await run({ op: 'queueReply', pane: 'w1:p1', text: '  next, the tests  ' })).toEqual({ id: 'q1' })
    expect(queueOps).toEqual([['add', 'w1:p1', basename(ROLLOUT, '.jsonl'), 'next, the tests']])
    await fails({ op: 'queueReply', pane: 'w1:p1', text: '   ' }, 'empty_text')
    await fails({ op: 'queueReply', pane: 'w1:p1', text: 'one too many' }, 'queue_full')
    await fails({ op: 'queueReply', pane: 'w1:p2', text: 'a shell' }, 'no_agent')
  })

  test('taking a message out tells whether it went out meanwhile', async () => {
    const { run } = setup()
    expect(await run({ op: 'unqueueReply', pane: 'w1:p1', id: 'q1' })).toEqual({})
    expect(await run({ op: 'unqueueReply', pane: 'w1:p1', id: 'gone' })).toEqual({ sent: true })
  })

  test('a web interrupt pauses the queue; resuming goes on', async () => {
    const { run, queueOps } = setup()
    await run({ op: 'interrupt', pane: 'w1:p1' })
    await run({ op: 'resumeQueue', pane: 'w1:p1' })
    expect(queueOps).toEqual([
      ['pause', 'w1:p1'],
      ['resume', 'w1:p1'],
    ])
  })
})
