import { afterAll, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProcessSession, findClaudeTranscript } from '../../../src/agents/claude/locate.ts'

const home = mkdtempSync(join(tmpdir(), 'claude-home-'))
const extra = mkdtempSync(join(tmpdir(), 'claude-extra-'))
afterAll(() => {
  setSystemTime()
  rmSync(home, { recursive: true, force: true })
  rmSync(extra, { recursive: true, force: true })
})

test('a transcript created after a miss is found once the short miss cache expires', () => {
  const session = '55555555-5555-4555-8555-555555555555'
  mkdirSync(join(home, 'projects', '-home-alice-project'), { recursive: true })
  const t0 = Date.now()
  setSystemTime(t0)
  expect(findClaudeTranscript(session, [home])).toBeNull()
  const path = join(home, 'projects', '-home-alice-project', `${session}.jsonl`)
  writeFileSync(path, '{}\n')
  setSystemTime(t0 + 6_000)
  expect(findClaudeTranscript(session, [home])).toBe(path)
  rmSync(path)
  expect(findClaudeTranscript(session, [home])).toBeNull()
})

test('searches every configured dir and rejects ids that are not plain names', () => {
  const session = '66666666-6666-4666-8666-666666666666'
  const dir = join(extra, 'projects', 'p')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${session}.jsonl`), '{}\n')
  expect(findClaudeTranscript(session, [home, extra])).toBe(join(dir, `${session}.jsonl`))
  expect(findClaudeTranscript('*', [home, extra])).toBeNull()
  expect(findClaudeTranscript('../x', [home, extra])).toBeNull()
})

test("a process's own registry names the session it shows; one attached to a background job shows the job's", () => {
  const own = '77777777-7777-4777-8777-777777777777'
  const job = '88888888-8888-4888-8888-888888888888'
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(join(home, 'jobs', '88888888'), { recursive: true })
  const register = (pid: number, entry: object) =>
    writeFileSync(join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, ...entry }))
  writeFileSync(join(home, 'jobs', '88888888', 'state.json'), JSON.stringify({ sessionId: job, template: 'bg' }))

  register(101, { sessionId: own })
  expect(claudeProcessSession(101, [home])).toBe(own)
  register(102, { sessionId: own, parkedJobId: '88888888' })
  expect(claudeProcessSession(102, [home])).toBe(job)
  // A job without a state file, or with a malformed id, falls back to the process's own session.
  register(103, { sessionId: own, parkedJobId: '99999999' })
  expect(claudeProcessSession(103, [home])).toBe(own)
  register(104, { sessionId: own, parkedJobId: '../../x' })
  expect(claudeProcessSession(104, [home])).toBe(own)
  // Another pid's entry, no entry, or an unreadable one names nothing.
  register(105, { pid: 999, sessionId: own })
  expect(claudeProcessSession(105, [home])).toBeNull()
  expect(claudeProcessSession(106, [home])).toBeNull()
  writeFileSync(join(home, 'sessions', '107.json'), '{not json')
  expect(claudeProcessSession(107, [home])).toBeNull()
})

test('a process whose own session last opened a background session with /resume shows that one', () => {
  const own = '99999999-9999-4999-8999-999999999999'
  const shown = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  mkdirSync(join(home, 'projects', '-home-alice-web'), { recursive: true })
  mkdirSync(join(home, 'jobs', 'aaaaaaaa'), { recursive: true })
  writeFileSync(join(home, 'jobs', 'aaaaaaaa', 'state.json'), JSON.stringify({ sessionId: shown }))
  // The registry keeps the process's own session, and names the spare its conversation went to.
  writeFileSync(
    join(home, 'sessions', '201.json'),
    JSON.stringify({ pid: 201, sessionId: own, parkedJobId: '8af0035d' }),
  )
  const opened = (job: string) => ({
    type: 'system',
    subtype: 'local_command',
    content: `<local-command-stdout>Opening "deep analysis", running in the background (${job})</local-command-stdout>`,
  })
  const write = (...rows: object[]) =>
    writeFileSync(
      join(home, 'projects', '-home-alice-web', `${own}.jsonl`),
      `${rows.map(r => JSON.stringify(r)).join('\n')}\n`,
    )
  write(
    { type: 'system', subtype: 'local_command', content: '<command-name>/resume</command-name>' },
    opened('aaaaaaaa'),
    { type: 'continued-in', continuedInSessionId: '8af0035d-ee2f-4716-b659-1771132406af' },
  )
  expect(claudeProcessSession(201, [home])).toBe(shown)
  // Talking in its own session again ends it; a job that is gone counts for nothing.
  write(opened('aaaaaaaa'), { type: 'user', message: { role: 'user', content: 'hi' } })
  expect(claudeProcessSession(201, [home])).toBe(own)
  write(opened('bbbbbbbb'))
  expect(claudeProcessSession(201, [home])).toBe(own)
})
