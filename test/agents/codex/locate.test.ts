import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type PickOptions,
  type RolloutCandidate,
  claimedElsewhere,
  codexSessionId,
  historyBase,
  historyBaseRef,
  listRollouts,
  locateCodexRollout,
  paneRollouts,
  pickRollout,
  pinRollout,
  resumeCandidates,
  resumedRollout,
  rolloutById,
  rolloutMetaFrom,
  rolloutProven,
  setLiveCodexPanes,
  shownRollout,
  touchedRollouts,
} from '../../../src/agents/codex/locate.ts'
import { fixture } from '../helpers.ts'

const CWD = '/home/alice/project'
const T0 = Date.parse('2026-03-10T08:00:00Z')
const cand = (path: string, created: number, extra: Partial<RolloutCandidate> = {}): RolloutCandidate => ({
  path,
  id: path,
  cwd: CWD,
  created,
  originator: 'codex-tui',
  mtime: created,
  ...extra,
})
const opts = (o: Partial<PickOptions> = {}): PickOptions => ({
  cwd: CWD,
  startedAt: T0,
  forkParentId: null,
  claimed: new Set(),
  current: null,
  siblings: 0,
  ...o,
})

describe('pickRollout', () => {
  const mine = cand('mine', T0 + 1000)
  const later = cand('later', T0 + 60_000, { mtime: T0 + 999_999 })
  const before = cand('before', T0 - 60_000, { mtime: T0 + 5_000_000 })

  test('a fresh pane gets the earliest rollout created after its process started', () => {
    expect(pickRollout([later, before, mine], opts())).toBe('mine')
  })

  test('process start time has a few seconds of slack', () => {
    expect(pickRollout([cand('early', T0 - 3000)], opts())).toBe('early')
    expect(pickRollout([cand('early', T0 - 6000)], opts())).toBeNull()
  })

  test('skips other cwds, codex exec runs, claimed rollouts and the fork parent', () => {
    const list = [
      cand('elsewhere', T0 + 1, { cwd: '/home/alice/other' }),
      cand('exec', T0 + 2, { originator: 'codex_exec' }),
      cand('claimed', T0 + 3),
      cand('parent', T0 + 4, { id: 'parent-id' }),
      cand('ok', T0 + 5),
    ]
    expect(pickRollout(list, opts({ claimed: new Set(['claimed']), forkParentId: 'parent-id' }))).toBe('ok')
  })

  test('without a process start time, the most recently written rollout wins', () => {
    expect(pickRollout([mine, later, before], opts({ startedAt: 0 }))).toBe('before')
  })

  test('/new: a newer rollout replaces the current one when no other pane could own it', () => {
    const current = { path: 'mine', created: mine.created }
    const newer = cand('newer', T0 + 120_000)
    expect(pickRollout([mine, later, newer], opts({ current }))).toBe('newer')
    expect(pickRollout([mine, later, newer], opts({ current, siblings: 1 }))).toBe('mine')
    expect(pickRollout([mine], opts({ current }))).toBe('mine')
    expect(pickRollout([], opts({ current }))).toBe('mine')
  })

  test('an explicit rollout (codex resume <id>, or proven by the screen) is never replaced by a newer file', () => {
    const current = { path: 'mine', created: mine.created, explicit: true }
    expect(pickRollout([mine, cand('newer', T0 + 120_000)], opts({ current }))).toBe('mine')
  })

  test('a rollout created while another Codex pane of the folder was alive is never /new, even once it closed', () => {
    const current = { path: 'mine', created: mine.created }
    const theirs = cand('theirs', T0 + 120_000)
    const othersAlive = [{ from: T0 + 100_000, to: T0 + 130_000 }]
    expect(pickRollout([mine, theirs], opts({ current, othersAlive }))).toBe('mine')
    // Before it was reported, with a few seconds' slack, or after it was gone: nothing else could have written it.
    const after = cand('after', T0 + 200_000)
    expect(pickRollout([mine, after], opts({ current, othersAlive }))).toBe('after')
    expect(pickRollout([mine, cand('just-before', T0 + 97_000)], opts({ current, othersAlive }))).toBe('mine')
  })

  test('/new waits until a newer rollout has settled: a codex fork in a new pane writes one at once', () => {
    const current = { path: 'mine', created: mine.created }
    const fork = cand('fork', T0 + 120_000)
    expect(pickRollout([mine, fork], opts({ current, now: T0 + 121_000 }))).toBe('mine')
    expect(pickRollout([mine, fork], opts({ current, now: T0 + 131_000 }))).toBe('fork')
  })
})

describe('rollout files', () => {
  let root: string
  const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
  const rollout = (day: string, n: number, cwd: string, created: number, base = root) => {
    const dir = join(base, ...day.split('/'))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `rollout-${day.replaceAll('/', '-')}T00-00-00-${uuid(n)}.jsonl`)
    const ts = new Date(created).toISOString()
    writeFileSync(
      path,
      `${JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: uuid(n), timestamp: ts, cwd, originator: 'codex-tui' } })}\n`,
    )
    utimesSync(path, created / 1000, created / 1000)
    return path
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-sessions-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('listRollouts walks every day directory, newest first, and stops before `since`', () => {
    const days = [
      '2026/02/20',
      '2026/02/27',
      '2026/03/01',
      '2026/03/02',
      '2026/03/03',
      '2026/03/04',
      '2026/03/05',
      '2026/03/09',
    ]
    const paths = days.map((d, i) => rollout(d, i + 1, '/home/alice/days', T0 - (days.length - i) * 86_400_000))
    expect(listRollouts(root)).toEqual([...paths].reverse())
    expect(listRollouts(root, Date.parse('2026-03-05T12:00:00'))).toEqual([paths[7], paths[6], paths[5]])
  })

  test('rolloutById finds old rollouts by session id', () => {
    const old = rollout('2025/12/31', 19, '/home/alice/old', T0 - 70 * 86_400_000)
    expect(rolloutById(uuid(19), root)).toBe(old)
    expect(rolloutById('ffffffff-0000-4000-8000-000000000000', root)).toBeNull()
  })

  test('locateCodexRollout: sticky, claims, then follows /new', () => {
    const cwd = '/home/alice/locate'
    const a = rollout('2026/03/10', 25, cwd, T0 + 1000)
    const b = rollout('2026/03/10', 26, cwd, T0 + 5000)
    const input = (pane: string, startedAt: number) => ({ pane, cwd, resumeId: null, forkParentId: null, startedAt })
    expect(locateCodexRollout(input('w1:p1', T0), root, T0 + 10_000)).toBe(a)
    expect(locateCodexRollout(input('w1:p2', T0 + 4000), root, T0 + 10_000)).toBe(b)
    // Both panes are live in the same cwd, so a newer rollout is nobody's /new yet.
    const c = rollout('2026/03/10', 27, cwd, T0 + 20_000)
    expect(locateCodexRollout(input('w1:p1', T0), root, T0 + 30_000)).toBe(a)
    // Once the other pane is gone, the newer rollout must be this process's /new.
    expect(locateCodexRollout(input('w1:p1', T0), root, T0 + 200_000)).toBe(c)
    expect(locateCodexRollout(input('w1:p1', T0), root, T0 + 200_001)).toBe(c)
  })

  test('locateCodexRollout: without /proc the start time jitters, and the pane still follows /new', () => {
    const cwd = '/home/alice/jitter'
    const a = rollout('2026/03/10', 30, cwd, T0 + 1000)
    const input = (startedAt: number) => ({ pane: 'w3:p1', cwd, resumeId: null, forkParentId: null, startedAt })
    expect(locateCodexRollout(input(T0), root, T0 + 10_000)).toBe(a)
    const b = rollout('2026/03/10', 31, cwd, T0 + 20_000)
    expect(locateCodexRollout(input(T0 + 700), root, T0 + 30_000)).toBe(b)
    expect(locateCodexRollout(input(T0 - 400), root, T0 + 35_000)).toBe(b)
  })

  test("locateCodexRollout: a resumed session keeps its rollout when somebody else's appears in the folder", () => {
    const cwd = '/home/alice/resume-kept'
    const resumeRoot = mkdtempSync(join(tmpdir(), 'codex-resume-'))
    try {
      const a = rollout('2026/03/09', 40, cwd, T0 - 3_600_000, resumeRoot)
      const pane = { pane: 'w2:p5', cwd, resumeId: uuid(40), forkParentId: null, startedAt: T0 }
      expect(locateCodexRollout(pane, resumeRoot, T0 + 1000)).toBe(a)
      rollout('2026/03/10', 41, cwd, T0 + 10_000, resumeRoot)
      expect(locateCodexRollout(pane, resumeRoot, T0 + 20_000)).toBe(a)
      expect(locateCodexRollout(pane, resumeRoot, T0 + 300_000)).toBe(a)
    } finally {
      rmSync(resumeRoot, { recursive: true, force: true })
    }
  })

  test('locateCodexRollout: a live pane that was never looked up still owns the newer rollout', () => {
    const cwd = '/home/alice/live'
    const a = rollout('2026/03/10', 45, cwd, T0 + 1000)
    const input = { pane: 'w4:p1', cwd, resumeId: null, forkParentId: null, startedAt: T0 }
    expect(locateCodexRollout(input, root, T0 + 10_000)).toBe(a)
    const b = rollout('2026/03/10', 46, cwd, T0 + 20_000)
    // w4:p2 works (so nothing looks it up) in the same folder: b may be its rollout.
    setLiveCodexPanes(
      [
        { pane: 'w4:p1', cwd },
        { pane: 'w4:p2', cwd },
      ],
      T0 + 200_000,
    )
    expect(locateCodexRollout(input, root, T0 + 200_000)).toBe(a)
    setLiveCodexPanes([{ pane: 'w4:p1', cwd }], T0 + 201_000)
    expect(locateCodexRollout(input, root, T0 + 201_000)).toBe(b)
  })

  test('locateCodexRollout: what a closed pane of the same folder wrote is not taken for /new', () => {
    const cwd = '/home/alice/scratch'
    const a = rollout('2026/03/10', 70, cwd, T0 + 1000)
    const input = { pane: 'w7:p1', cwd, resumeId: null, forkParentId: null, startedAt: T0 }
    setLiveCodexPanes([{ pane: 'w7:p1', cwd }], T0 + 5000)
    expect(locateCodexRollout(input, root, T0 + 5000)).toBe(a)
    // A scratch Codex opens beside it, writes its rollout and closes, all while w7:p1 works and is not looked up.
    setLiveCodexPanes(
      [
        { pane: 'w7:p1', cwd },
        { pane: 'w7:p2', cwd },
      ],
      T0 + 10_000,
    )
    const scratch = rollout('2026/03/10', 71, cwd, T0 + 20_000)
    setLiveCodexPanes(
      [
        { pane: 'w7:p1', cwd },
        { pane: 'w7:p2', cwd },
      ],
      T0 + 60_000,
    )
    setLiveCodexPanes([{ pane: 'w7:p1', cwd }], T0 + 70_000)
    expect(locateCodexRollout(input, root, T0 + 300_000)).toBe(a)
    expect(paneRollouts('w7:p1', cwd, T0, root, T0 + 300_000)).toEqual([scratch, a])
    // A /new of its own, after the other one closed, is followed.
    const own = rollout('2026/03/10', 72, cwd, T0 + 400_000)
    expect(locateCodexRollout(input, root, T0 + 500_000)).toBe(own)
    expect(rolloutProven('w7:p1')).toBe(false)
  })

  test('pinRollout: the user says which rollout a pane shows, and no newer file moves it', () => {
    const cwd = '/home/alice/pinned'
    const a = rollout('2026/03/10', 75, cwd, T0 + 1000)
    const b = rollout('2026/03/10', 76, cwd, T0 + 20_000)
    const input = { pane: 'w8:p1', cwd, resumeId: null, forkParentId: null, startedAt: T0 }
    expect(locateCodexRollout(input, root, T0 + 100_000)).toBe(a)
    expect(locateCodexRollout(input, root, T0 + 100_001)).toBe(b)
    pinRollout('w8:p1', a, { cwd, startedAt: T0 }, T0 + 100_002)
    expect(rolloutProven('w8:p1')).toBe(true)
    rollout('2026/03/10', 77, cwd, T0 + 150_000)
    expect(locateCodexRollout(input, root, T0 + 200_000)).toBe(a)
    // Another pane never lists what this one shows.
    expect(paneRollouts('w8:p2', cwd, T0, root, T0 + 200_000)).not.toContain(a)
  })

  test('a closed pane stops claiming its rollout', () => {
    const cwd = '/home/alice/closed'
    const a = rollout('2026/03/10', 47, cwd, T0 + 1000)
    locateCodexRollout({ pane: 'w5:p1', cwd, resumeId: null, forkParentId: null, startedAt: T0 }, root, T0 + 5000)
    expect(claimedElsewhere(a, 'w5:p2')).toBe(true)
    expect(claimedElsewhere(a, 'w5:p1')).toBe(false)
    setLiveCodexPanes([], T0 + 6000)
    expect(claimedElsewhere(a, 'w5:p2')).toBe(false)
  })

  test('Codex 0.164 segments: a resumed session goes on in a newer file, and the pane follows it', () => {
    const cwd = '/home/alice/segments'
    const segRoot = mkdtempSync(join(tmpdir(), 'codex-segments-'))
    try {
      const dir = join(segRoot, '2026', '03', '10')
      mkdirSync(dir, { recursive: true })
      const id = uuid(60)
      const segment = (time: string, n: number | null, created: number) => {
        const name = `rollout-2026-03-10T${time}-${id}${n === null ? '' : `_${uuid(n)}`}.jsonl`
        const path = join(dir, name)
        const ts = new Date(created).toISOString()
        const history_base = n === null ? undefined : { thread_id: id, end_ordinal_exclusive: 3, end_byte_offset: 100 }
        const meta = { id, timestamp: ts, cwd, originator: 'codex-tui', history_base }
        writeFileSync(path, `${JSON.stringify({ timestamp: ts, type: 'session_meta', payload: meta })}\n`)
        utimesSync(path, created / 1000, created / 1000)
        return path
      }
      const first = segment('07-00-00', null, T0 - 3_600_000)
      const pane = { pane: 'w6:p1', cwd, resumeId: id, forkParentId: null, startedAt: T0 }
      expect(locateCodexRollout(pane, segRoot, T0 + 1000)).toBe(first)
      // `codex resume` opens the next segment once the session goes on.
      const second = segment('08-00-05', 61, T0 + 5000)
      expect(codexSessionId(second)).toBe(id)
      expect(locateCodexRollout(pane, segRoot, T0 + 10_000)).toBe(second)
      expect(historyBase(second)).toEqual({ path: first, endOffset: 100 })
      const third = segment('08-30-00', 62, T0 + 1_800_000)
      expect(locateCodexRollout(pane, segRoot, T0 + 1_810_000)).toBe(third)
      expect(historyBase(third)).toEqual({ path: second, endOffset: 100 })
      expect(rolloutById(id, segRoot)).toBe(third)
      expect(rolloutById(id, segRoot, second)).toBe(first)
      // A fresh `codex resume <id>` starts from the newest segment.
      expect(locateCodexRollout({ ...pane, pane: 'w6:p2', startedAt: T0 + 2_000_000 }, segRoot, T0 + 2_000_000)).toBe(
        third,
      )
    } finally {
      rmSync(segRoot, { recursive: true, force: true })
    }
  })

  test('locateCodexRollout: a resumed session starts from its rollout', () => {
    const cwd = '/home/alice/resume'
    const resumeRoot = mkdtempSync(join(tmpdir(), 'codex-resume-'))
    try {
      const old = rollout('2026/01/15', 38, cwd, T0 - 40 * 86_400_000, resumeRoot)
      const pane = { pane: 'w2:p1', cwd, resumeId: uuid(38), forkParentId: null, startedAt: T0 }
      expect(locateCodexRollout(pane, resumeRoot, T0 + 1000)).toBe(old)
    } finally {
      rmSync(resumeRoot, { recursive: true, force: true })
    }
  })
})

describe('session_meta and history_base', () => {
  test('rolloutMetaFrom reads cwd (escaped), timestamp and originator from a truncated head', () => {
    const path = '/s/rollout-2026-01-02T10-00-00-33333333-3333-4333-8333-333333333333.jsonl'
    const head =
      '{"timestamp":"2026-01-02T10:00:00.000Z","type":"session_meta","payload":{"cwd":"/home/alice/a \\"b\\"","originator":"codex_exec","base_instructions":{"text":"trunc'
    expect(rolloutMetaFrom(path, head)).toEqual({
      path,
      id: '33333333-3333-4333-8333-333333333333',
      cwd: '/home/alice/a "b"',
      created: Date.parse('2026-01-02T10:00:00.000Z'),
      originator: 'codex_exec',
    })
    expect(rolloutMetaFrom(path, '{"type":"session_meta"')).toBeNull()
  })

  test('codexSessionId', () => {
    expect(codexSessionId('/x/rollout-2026-09-07T11-50-58-01a079fd-9a5f-7810-84e5-aba267c264cb.jsonl')).toBe(
      '01a079fd-9a5f-7810-84e5-aba267c264cb',
    )
    expect(
      codexSessionId(
        '/x/rollout-2026-10-24T12-04-00-099d7573-092b-4b12-876f-d0c872eaf8ce_01a16c14-6d47-7242-bce3-f020c06f7ee3.jsonl',
      ),
    ).toBe('099d7573-092b-4b12-876f-d0c872eaf8ce')
    expect(codexSessionId('/x/notes.jsonl')).toBeNull()
  })

  test('historyBaseRef parses JSON, or falls back to a regex on a truncated line', () => {
    const hb = { thread_id: '33333333-3333-4333-8333-333333333333', end_ordinal_exclusive: 4, end_byte_offset: 922 }
    const line = JSON.stringify({ type: 'session_meta', payload: { id: 'x', history_base: hb } })
    const want = { threadId: hb.thread_id, endOffset: 922 }
    expect(historyBaseRef(line)).toEqual(want)
    expect(historyBaseRef(line.slice(0, -3))).toEqual(want)
    expect(historyBaseRef(JSON.stringify({ type: 'session_meta', payload: {} }))).toBeNull()
  })

  test('historyBase resolves the parent rollout in the same sessions tree', () => {
    const day = fixture('codex', 'sessions', '2026', '01', '02')
    const child = join(day, 'rollout-2026-01-02T10-05-00-44444444-4444-4444-8444-444444444444.jsonl')
    expect(historyBase(child)).toEqual({
      path: join(day, 'rollout-2026-01-02T10-00-00-33333333-3333-4333-8333-333333333333.jsonl'),
      endOffset: 922,
    })
    expect(historyBase(join(day, 'rollout-2026-01-02T10-00-00-33333333-3333-4333-8333-333333333333.jsonl'))).toBeNull()
  })
})

describe('resumedRollout', () => {
  const own = { path: '/r/own.jsonl', prompt: 'fix the parser', at: T0 }
  const other = {
    path: '/r/old.jsonl',
    prompt: 'Count the lines in n.txt and tell me how many there are',
    at: T0 + 60_000,
  }
  const echo = 'Count the lines in n.txt and tell me how\nmany there are'
  const msg = (path: string, prompt: string | null, at = T0 + 60_000) => ({ path, prompt, at })

  test('follows the rollout whose newest message the pane shows, all of it', () => {
    expect(resumedRollout(echo, own, [other])).toBe('/r/old.jsonl')
  })

  test('stays when the pane shows its own newest message, nothing, or a sibling never shown here', () => {
    expect(resumedRollout('fix the parser', own, [other])).toBeNull()
    expect(resumedRollout(echo, { ...own, prompt: other.prompt }, [other])).toBeNull()
    expect(resumedRollout(null, own, [other])).toBeNull()
    expect(resumedRollout('', own, [other])).toBeNull()
    expect(resumedRollout(echo, own, [msg('/r/sibling.jsonl', 'something else')])).toBeNull()
    expect(resumedRollout(echo, own, [msg('/r/empty.jsonl', null)])).toBeNull()
  })

  test('identical prompts: neither the pane nor another rollout can be told apart, so the pane stays', () => {
    const current = msg('/r/current.jsonl', 'Continue', T0)
    expect(resumedRollout('Continue', current, [msg('/r/resumed.jsonl', 'Continue')])).toBeNull()
    expect(
      resumedRollout('Continue', msg('/r/current.jsonl', 'Earlier instruction', T0), [
        msg('/r/a.jsonl', 'Continue'),
        msg('/r/b.jsonl', 'Continue'),
      ]),
    ).toBeNull()
  })

  test('a prefix is not the message: "Continue" is not "Continue with deployment"', () => {
    const current = msg('/r/current.jsonl', 'Earlier instruction', T0)
    // The reviewer's case: the longer message used to win because it was listed first.
    expect(
      resumedRollout('Continue', current, [
        msg('/r/different-repository.jsonl', 'Continue with deployment'),
        msg('/r/actual-resume-target.jsonl', 'Continue'),
      ]),
    ).toBe('/r/actual-resume-target.jsonl')
    expect(resumedRollout('Continue', current, [msg('/r/longer.jsonl', 'Continue with deployment')])).toBeNull()
    expect(resumedRollout('Continue with deployment', current, [msg('/r/shorter.jsonl', 'Continue')])).toBeNull()
  })

  test('an echo cut short with … matches only when exactly one rollout goes on from it', () => {
    const current = msg('/r/current.jsonl', 'Earlier instruction', T0)
    const cut = 'Count the lines in n.txt and…'
    expect(resumedRollout(cut, current, [other])).toBe('/r/old.jsonl')
    expect(resumedRollout(cut, current, [other, msg('/r/twin.jsonl', 'Count the lines in n.txt and stop')])).toBeNull()
  })

  test("the echoed message must be newer than the pane's own newest message", () => {
    const named = msg('/r/argv-resume.jsonl', 'deploy it', T0 + 120_000)
    expect(resumedRollout(echo, named, [other])).toBeNull()
    expect(resumedRollout(echo, named, [{ ...other, at: T0 + 120_000 }])).toBeNull()
    expect(resumedRollout(echo, named, [{ ...other, at: T0 + 120_001 }])).toBe('/r/old.jsonl')
    expect(resumedRollout(echo, msg('/r/x.jsonl', 'deploy it', 0), [{ ...other, at: 0 }])).toBeNull()
  })
})

describe('shownRollout', () => {
  const r = (path: string, prompt: string | null) => ({ path, prompt, at: 0 })

  test('the one rollout whose newest message is the echo', () => {
    expect(shownRollout('fix the queue', [r('a', 'fix the queue'), r('b', 'run the tests')])).toBe('a')
  })

  test('none, several, an empty echo or a prefix prove nothing', () => {
    expect(shownRollout('something else', [r('a', 'fix the queue')])).toBeNull()
    expect(shownRollout('Continue', [r('a', 'Continue'), r('b', 'Continue')])).toBeNull()
    expect(shownRollout('  ', [r('a', '  ')])).toBeNull()
    expect(shownRollout(null, [r('a', 'x')])).toBeNull()
    expect(shownRollout('Continue', [r('a', 'Continue with deployment'), r('b', null)])).toBeNull()
  })
})

describe('resumeCandidates', () => {
  test("only interactive rollouts of the pane's folder, appended to after its own", () => {
    const root = mkdtempSync(join(tmpdir(), 'resume-'))
    try {
      let n = 0
      const file = (cwd: string, mtime: number, originator = 'codex-tui') => {
        const dir = join(root, '2026', '03', '10')
        mkdirSync(dir, { recursive: true })
        const id = `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`
        const path = join(dir, `rollout-2026-03-10T00-00-00-${id}.jsonl`)
        const ts = new Date(T0).toISOString()
        writeFileSync(
          path,
          `${JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id, timestamp: ts, cwd, originator } })}\n`,
        )
        utimesSync(path, mtime / 1000, mtime / 1000)
        return path
      }
      const current = file(CWD, T0 + 1_000)
      const resumed = file(CWD, T0 + 5_000)
      file('/home/alice/other-repository', T0 + 6_000)
      file(CWD, T0 + 7_000, 'codex_exec')
      file(CWD, T0 + 500)
      expect(resumeCandidates(current, CWD, root, T0 + 10_000)).toEqual([resumed])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('touchedRollouts', () => {
  test('rollouts of any day appended to after a time, newest first', () => {
    const root = mkdtempSync(join(tmpdir(), 'touched-'))
    try {
      const file = (day: string, name: string, mtime: number) => {
        mkdirSync(join(root, day), { recursive: true })
        const path = join(root, day, name)
        writeFileSync(path, '{}\n')
        utimesSync(path, mtime / 1000, mtime / 1000)
        return path
      }
      const old = file('2025/01/02', 'rollout-a.jsonl', T0 + 5_000)
      const fresh = file('2026/03/10', 'rollout-b.jsonl', T0 + 9_000)
      file('2026/03/10', 'rollout-c.jsonl', T0 - 1_000)
      expect(touchedRollouts(T0, root, T0 + 10_000)).toEqual([fresh, old])
      expect(touchedRollouts(T0 + 6_000, root, T0 + 10_000)).toEqual([fresh])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
