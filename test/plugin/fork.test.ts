import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ForkError,
  claudeCut,
  codexArgvSession,
  codexCut,
  findClaudeTranscript,
  findPaneIds,
  forkSession,
  keepFlags,
  lastMessageUuid,
  newestCodexSession,
  parseCli,
  parseEnviron,
  shellJoin,
  shellQuote,
  transcriptCwd,
} from '../../plugin/quick-fork/fork.ts'

const SESSION = '11111111-2222-4333-8444-555555555555'
const CODEX_ID = '01a16927-c5de-7bf2-aec7-69be67499326'
const PARENT_ID = '01a10000-0000-7000-8000-000000000001'

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'quick-fork-test-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const fresh = (name: string) => {
  const dir = join(root, `${name}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const jsonl = (rows: object[]) => rows.map(r => `${JSON.stringify(r)}\n`).join('')
const readRows = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

describe('keepFlags', () => {
  test('keeps the flags that shape a session and drops the rest', () => {
    const argv = ['claude', '--resume', SESSION, '--model', 'opus', '--verbose', '--dangerously-skip-permissions', '-c']
    expect(keepFlags(argv)).toEqual(['--model', 'opus', '--dangerously-skip-permissions'])
  })

  test('variadic flags take every value up to the next flag', () => {
    const argv = ['claude', '--add-dir', '/a', '/b', '--mcp-config', 'x.json', 'y.json', '--effort', 'high', 'extra']
    expect(keepFlags(argv)).toEqual(['--add-dir', '/a', '/b', '--mcp-config', 'x.json', 'y.json', '--effort', 'high'])
  })

  test('--flag=value keeps the single token', () => {
    expect(keepFlags(['claude', '--permission-mode=plan', '--model=sonnet', 'prompt'])).toEqual([
      '--permission-mode=plan',
      '--model=sonnet',
    ])
  })

  test('a valued flag followed by another flag keeps no value', () => {
    expect(keepFlags(['claude', '--model', '--chrome'])).toEqual(['--model', '--chrome'])
  })

  test('argv[0] is never a flag', () => {
    expect(keepFlags(['--model'])).toEqual([])
    expect(keepFlags([])).toEqual([])
  })
})

describe('parseEnviron', () => {
  const raw = Buffer.from(
    [
      'PATH=/usr/bin',
      'ANTHROPIC_API_KEY=sk-a=b',
      'CLAUDE_CONFIG_DIR=/home/alice/.claude',
      'CLAUDECODE=1',
      'CLAUDE_CODE_ENTRYPOINT=cli',
      'CLAUDE_CODE_SSE_PORT=1234',
      'OPENAI_API_KEY=sk-o',
      '=broken',
      'CLAUDE_$(id)=x',
      '',
    ].join('\0'),
  )

  test('keeps prefixed variables, skips the parent-session markers', () => {
    expect(parseEnviron(raw, ['CLAUDE_', 'ANTHROPIC_'])).toEqual({
      ANTHROPIC_API_KEY: 'sk-a=b',
      CLAUDE_CONFIG_DIR: '/home/alice/.claude',
    })
    expect(parseEnviron(raw, ['CODEX_', 'OPENAI_'])).toEqual({ OPENAI_API_KEY: 'sk-o' })
  })

  test('invalid UTF-8 does not throw', () => {
    const bad = Buffer.concat([Buffer.from('CLAUDE_X='), Buffer.from([0xff, 0xfe]), Buffer.from('\0')])
    expect(Object.keys(parseEnviron(bad, ['CLAUDE_']))).toEqual(['CLAUDE_X'])
  })
})

describe('shell quoting', () => {
  test('matches POSIX single-quote rules', () => {
    expect(shellQuote('')).toBe("''")
    expect(shellQuote('--model')).toBe('--model')
    expect(shellQuote('/a/b.c:d=e,f@g%h+i')).toBe('/a/b.c:d=e,f@g%h+i')
    expect(shellQuote('a b')).toBe("'a b'")
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`)
    expect(shellQuote('$HOME;rm')).toBe("'$HOME;rm'")
    expect(shellJoin(['claude', '-n', 'my title · fork'])).toBe("claude -n 'my title · fork'")
  })

  test('round-trips through a real POSIX shell', async () => {
    const args = [
      'plain',
      'two words',
      "it's",
      '$HOME `id` $(id)',
      'a\nb',
      '"double" \\back',
      '*',
      '',
      '-n',
      'model_reasoning_effort="high"',
      '中文 ✓',
    ]
    const script = `for a in ${shellJoin(args)}; do printf '%s\\0' "$a"; done`
    const out = await new Response(Bun.spawn(['sh', '-c', script], { stdout: 'pipe' }).stdout).text()
    expect(out.split('\0').slice(0, -1)).toEqual(args)
  })
})

describe('findPaneIds', () => {
  test('collects pane ids depth first', () => {
    const made = {
      result: { tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p9' }, panes: [{ pane_id: 'w1:p1' }] },
    }
    expect(findPaneIds(made)).toEqual(['w1:p9', 'w1:p1'])
    expect(findPaneIds(null)).toEqual([])
  })
})

describe('codexArgvSession', () => {
  test('resume gives the session, fork gives the parent', () => {
    expect(codexArgvSession(['codex', 'resume', CODEX_ID])).toEqual({ resume: CODEX_ID, parent: null })
    expect(codexArgvSession(['codex', 'fork', PARENT_ID])).toEqual({ resume: null, parent: PARENT_ID })
    expect(codexArgvSession(['codex', 'resume', '--last'])).toEqual({ resume: null, parent: null })
    expect(codexArgvSession([])).toEqual({ resume: null, parent: null })
  })
})

describe('parseCli', () => {
  test('pane from argv, then the plugin context, then HERDR_PANE_ID', () => {
    expect(parseCli(['tab', 'w1:p2', '--at', 'x'], {})).toEqual({
      mode: 'tab',
      pane: 'w1:p2',
      session: undefined,
      at: 'x',
    })
    expect(
      parseCli(['down', '--session', SESSION], { HERDR_PLUGIN_CONTEXT_JSON: '{"focused_pane_id":"w1:p3"}' }),
    ).toEqual({
      mode: 'down',
      pane: 'w1:p3',
      session: SESSION,
      at: undefined,
    })
    expect(parseCli([], { HERDR_PLUGIN_CONTEXT_JSON: 'not json', HERDR_PANE_ID: 'w1:p4' }).pane).toBe('w1:p4')
    expect(parseCli([], {}).mode).toBe('right')
    expect(parseCli(['right', '--at'], {}).at).toBeUndefined()
  })

  test('rejects an unknown mode', () => {
    expect(() => parseCli(['left'], {})).toThrow(/unknown mode/)
  })
})

function claudeHome(rows: object[]) {
  const home = fresh('claude')
  const project = join(home, 'projects', '-home-alice-project')
  mkdirSync(project, { recursive: true })
  const path = join(project, `${SESSION}.jsonl`)
  writeFileSync(path, jsonl(rows))
  return { home, path }
}

const base = { sessionId: SESSION, session_id: SESSION, cwd: '/home/alice/project' }
const user = (uuid: string, text: string) => ({ ...base, type: 'user', uuid, message: { role: 'user', content: text } })
const assistant = (uuid: string, id: string, block: object) => ({
  ...base,
  type: 'assistant',
  uuid,
  message: { id, role: 'assistant', content: [block] },
})
const toolResult = (uuid: string, toolUseId: string) => ({
  ...base,
  type: 'user',
  uuid,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
})

const TRANSCRIPT = [
  { type: 'permission-mode', sessionId: SESSION, permissionMode: 'default' },
  user('u1', 'first question'),
  assistant('a1', 'msg_1', { type: 'text', text: 'first answer' }),
  user('u2', `second question mentions ${SESSION}`),
  assistant('a2-think', 'msg_2', { type: 'thinking', thinking: '' }),
  assistant('a2-text', 'msg_2', { type: 'text', text: 'let me look' }),
  { type: 'api-request', sessionId: SESSION, id: 'req_1' },
  assistant('a2-tool', 'msg_2', { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }),
  { type: 'api-request-blob', sessionId: SESSION },
  toolResult('r1', 'toolu_1'),
  { type: 'attachment', sessionId: SESSION, uuid: 'att1' },
  assistant('a3', 'msg_3', { type: 'text', text: 'done' }),
  user('u3', 'third'),
]

describe('claudeCut', () => {
  test('cuts after a single-row reply and rewrites only the session id fields', () => {
    const { path } = claudeHome(TRANSCRIPT)
    const cut = claudeCut(path, SESSION, 'a1')
    expect(cut.path).toBe(join(path, '..', `${cut.id}.jsonl`))
    const rows = readRows(cut.path)
    expect(rows.map(r => r.uuid ?? r.type)).toEqual(['permission-mode', 'u1', 'a1'])
    for (const r of rows) {
      expect(r.sessionId).toBe(cut.id)
      if ('session_id' in r) expect(r.session_id).toBe(cut.id)
    }
    expect(statSync(cut.path).mode & 0o777).toBe(0o600)
  })

  test('keeps the rest of a multi-block assistant message and the tool results answering it', () => {
    const { path } = claudeHome(TRANSCRIPT)
    const rows = readRows(claudeCut(path, SESSION, 'a2-text').path)
    expect(rows.map(r => r.uuid ?? r.type)).toEqual([
      'permission-mode',
      'u1',
      'a1',
      'u2',
      'a2-think',
      'a2-text',
      'api-request',
      'a2-tool',
      'api-request-blob',
      'r1',
    ])
    expect(rows[3].message.content).toContain(SESSION)
  })

  test('a user row as the fork point ends the copy right there', () => {
    const { path } = claudeHome(TRANSCRIPT)
    expect(readRows(claudeCut(path, SESSION, 'u2').path).at(-1).uuid).toBe('u2')
  })

  test('an unknown message is an error and writes nothing', () => {
    const { path } = claudeHome(TRANSCRIPT)
    expect(() => claudeCut(path, SESSION, 'nope')).toThrow(ForkError)
    expect(readdirSync(join(path, '..'))).toEqual([`${SESSION}.jsonl`])
  })

  test('skips unparseable lines', () => {
    const { path } = claudeHome([])
    writeFileSync(path, `not json\n${jsonl([user('u1', 'hi'), assistant('a1', 'm', { type: 'text', text: 'yo' })])}`)
    expect(readRows(claudeCut(path, SESSION, 'a1').path).map(r => r.uuid)).toEqual(['u1', 'a1'])
  })
})

describe('lastMessageUuid', () => {
  test('the newest user or assistant row on the main thread', () => {
    expect(lastMessageUuid(claudeHome(TRANSCRIPT).path)).toBe('u3')
    const tail = [
      ...TRANSCRIPT,
      { ...assistant('side', 'msg_9', { type: 'text', text: 'x' }), isSidechain: true },
      { type: 'attachment', sessionId: SESSION, uuid: 'att2' },
      { type: 'custom-title', sessionId: SESSION, customTitle: 'x' },
    ]
    expect(lastMessageUuid(claudeHome(tail).path)).toBe('u3')
    expect(lastMessageUuid(claudeHome([{ type: 'permission-mode', sessionId: SESSION }]).path)).toBeNull()
  })
})

describe('Claude transcript lookup', () => {
  test('finds the transcript in the first config dir that has it, and its cwd', () => {
    const { home, path } = claudeHome(TRANSCRIPT)
    expect(findClaudeTranscript(SESSION, [join(root, 'missing'), home])).toBe(path)
    expect(findClaudeTranscript('../../etc/passwd', [home])).toBeNull()
    expect(transcriptCwd(path)).toBe('/home/alice/project')
    expect(transcriptCwd(join(root, 'missing.jsonl'))).toBeNull()
  })
})

const meta = (id: string, cwd = '/home/alice/project', extra: object = {}) => ({
  timestamp: '2026-01-02T03:04:05.000Z',
  type: 'session_meta',
  payload: { session_id: id, id, timestamp: '2026-01-02T03:04:05.000Z', cwd, originator: 'codex-tui', ...extra },
})

function rollout(home: string, id: string, rows: object[], day = '2026/01/02') {
  const dir = join(home, 'sessions', day)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-01-02T03-04-05-${id}.jsonl`)
  writeFileSync(path, jsonl(rows))
  return path
}

const CODEX_ROWS = [
  meta(CODEX_ID),
  { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: CODEX_ID } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: `id is ${CODEX_ID}` }] } },
  { type: 'token_usage_record', payload: { thread_id: CODEX_ID, session_id: CODEX_ID, usage: { n: 1 } } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'second turn' }] } },
]

const offsetAfter = (path: string, rows: number) => {
  const text = readFileSync(path, 'utf8')
  let off = 0
  for (let i = 0; i < rows; i++) off = text.indexOf('\n', off) + 1
  return Buffer.byteLength(text.slice(0, off))
}

describe('codexCut', () => {
  const now = new Date(2026, 4, 6, 7, 8, 9)

  test('copies up to the turn boundary under a new id, rewriting id fields only', () => {
    const home = fresh('codex')
    const src = rollout(home, CODEX_ID, CODEX_ROWS)
    const cut = codexCut(`${src}#${offsetAfter(src, 5)}`, home, now)
    expect(cut.path).toBe(join(home, 'sessions', '2026', '05', '06', `rollout-2026-05-06T07-08-09-${cut.id}.jsonl`))
    const raw = readFileSync(cut.path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const rows = raw
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
    expect(rows).toHaveLength(5)
    expect(rows[0].payload).toMatchObject({ id: cut.id, session_id: cut.id, timestamp: now.toISOString() })
    expect(rows[1].payload.thread_id).toBe(cut.id)
    expect(rows[2].payload.content[0].text).toBe(`id is ${CODEX_ID}`)
    expect(rows[3].payload).toMatchObject({ thread_id: cut.id, session_id: cut.id })
    expect(raw).not.toContain('second turn')
    expect(raw.split('\n')[1]).toBe(JSON.stringify(rows[1]))
  })

  test('a meta line with only session_id gets the new id', () => {
    const home = fresh('codex')
    const first = { type: 'session_meta', payload: { session_id: CODEX_ID, cwd: '/x' } }
    const src = rollout(home, CODEX_ID, [first, CODEX_ROWS[1] as object, CODEX_ROWS[4] as object])
    const cut = codexCut(`${src}#${offsetAfter(src, 3)}`, home, now)
    const rows = readRows(cut.path)
    expect(rows[0].payload).toEqual({ session_id: cut.id, cwd: '/x', timestamp: now.toISOString() })
    expect(rows[1].payload.thread_id).toBe(cut.id)
    expect('id' in rows[0].payload).toBe(false)
  })

  test('keeps fork lineage fields of the source as they are', () => {
    const home = fresh('codex')
    const src = rollout(home, CODEX_ID, [meta(CODEX_ID, '/x', { forked_from_id: PARENT_ID }), CODEX_ROWS[4] as object])
    const cut = codexCut(`${src}#${offsetAfter(src, 2)}`, home, now)
    expect(readRows(cut.path)[0].payload.forked_from_id).toBe(PARENT_ID)
  })

  test('rejects offsets off a line boundary, at zero, on the meta line, or past the end', () => {
    const home = fresh('codex')
    const src = rollout(home, CODEX_ID, CODEX_ROWS)
    const size = statSync(src).size
    for (const off of [0, 5, offsetAfter(src, 1), offsetAfter(src, 2) - 1, size + 10])
      expect(() => codexCut(`${src}#${off}`, home, now)).toThrow(ForkError)
    expect(readdirSync(join(home, 'sessions', '2026'))).toEqual(['01'])
  })

  test('rejects a line boundary inside a turn: the copy would end on a tool call without its output', () => {
    const home = fresh('codex')
    const call = {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'c1', name: 'exec', arguments: '{}' },
    }
    const src = rollout(home, CODEX_ID, [meta(CODEX_ID), CODEX_ROWS[2] as object, call])
    for (const rows of [2, 3])
      expect(() => codexCut(`${src}#${offsetAfter(src, rows)}`, home, now)).toThrow(/turn boundary/)
    expect(readdirSync(join(home, 'sessions', '2026'))).toEqual(['01'])
  })

  test('accepts the end of an interrupted turn', () => {
    const home = fresh('codex')
    const aborted = { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }
    const src = rollout(home, CODEX_ID, [meta(CODEX_ID), CODEX_ROWS[2] as object, aborted, CODEX_ROWS[5] as object])
    expect(readRows(codexCut(`${src}#${offsetAfter(src, 3)}`, home, now).path)).toHaveLength(3)
  })

  test('an offset past the end of the file is rejected before anything is read', () => {
    const home = fresh('codex')
    const src = rollout(home, CODEX_ID, CODEX_ROWS)
    expect(() => codexCut(`${src}#${Number.MAX_SAFE_INTEGER}`, home, now)).toThrow(/turn boundary/)
    expect(() => codexCut(`${src}#99999999999999999999`, home, now)).toThrow(ForkError)
  })

  test('rejects paths outside the sessions dir and malformed marks', () => {
    const home = fresh('codex')
    const src = rollout(home, CODEX_ID, CODEX_ROWS)
    const other = fresh('elsewhere')
    for (const at of [
      `${src}`,
      `${src}#abc`,
      `${join(other, 'x.jsonl')}#10`,
      `${join(home, 'sessions', '..', 'x.jsonl')}#10`,
      `${src.replace('.jsonl', '.txt')}#10`,
    ])
      expect(() => codexCut(at, home, now)).toThrow(/not a Codex fork point/)
    expect(() => codexCut(`${join(home, 'sessions', 'gone.jsonl')}#10`, home, now)).toThrow(/not found/)
  })

  test('rejects a rollout that does not start with session_meta', () => {
    const home = fresh('codex')
    const src = rollout(home, CODEX_ID, [CODEX_ROWS[1] as object, CODEX_ROWS[4] as object])
    expect(() => codexCut(`${src}#${offsetAfter(src, 2)}`, home, now)).toThrow(/session_meta/)
  })
})

describe('newestCodexSession', () => {
  test('the most recently written interactive rollout in the cwd wins', () => {
    const home = fresh('codex')
    const ids = [1, 2, 3, 4].map(n => `01a10000-0000-7000-8000-00000000000${n}`)
    const old = rollout(home, ids[0] as string, [meta(ids[0] as string)], '2025/12/31')
    const exec = rollout(home, ids[1] as string, [meta(ids[1] as string, undefined, { originator: 'codex_exec' })])
    const elsewhere = rollout(home, ids[2] as string, [meta(ids[2] as string, '/home/alice/other')])
    const mid = rollout(home, ids[3] as string, [meta(ids[3] as string)])
    const t = Date.now() / 1000
    utimesSync(old, t, t)
    utimesSync(exec, t, t)
    utimesSync(elsewhere, t, t)
    utimesSync(mid, t - 100, t - 100)
    expect(newestCodexSession(home, '/home/alice/project')).toBe(ids[0] as string)
    expect(newestCodexSession(home, '/home/alice/project', ids[0])).toBe(ids[3] as string)
    expect(newestCodexSession(home, '/nowhere')).toBeNull()
    expect(newestCodexSession(join(root, 'no-codex'), '/x')).toBeNull()
  })
})

const FAKE_HERDR = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
const dir = process.argv[1].replace(/\\/herdr$/, '')
const cfg = JSON.parse(readFileSync(dir + '/config.json', 'utf8'))
const args = process.argv.slice(2)
const key = args.slice(0, 2).join(' ')
const call = { args }
if (key === 'pane run') {
  const file = /^\\. '?([^' ;]+)'?;/.exec(args[3] ?? '')?.[1]
  if (file) call.envFile = { path: file, exists: existsSync(file), mode: statSync(file).mode & 0o777, body: readFileSync(file, 'utf8') }
}
appendFileSync(dir + '/calls.jsonl', JSON.stringify(call) + '\\n')
if (cfg.fail?.[key]) { console.error(cfg.fail[key]); process.exit(1) }
const out = cfg.responses[key]
// Like the real herdr, \`pane run\` prints nothing on success.
if (out === undefined && key === 'pane run') process.exit(0)
process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out ?? { result: {} }))
`

describe('forkSession', () => {
  let dir: string
  let herdrBin: string
  let child: ReturnType<typeof Bun.spawn> | null = null
  const savedRuntimeDir = process.env.XDG_RUNTIME_DIR

  beforeAll(() => {
    dir = fresh('herdr')
    herdrBin = join(dir, 'herdr')
    writeFileSync(herdrBin, FAKE_HERDR)
    chmodSync(herdrBin, 0o755)
    process.env.XDG_RUNTIME_DIR = fresh('runtime')
  })
  afterAll(() => {
    if (savedRuntimeDir === undefined) Reflect.deleteProperty(process.env, 'XDG_RUNTIME_DIR')
    else process.env.XDG_RUNTIME_DIR = savedRuntimeDir
  })
  afterEach(() => {
    child?.kill()
    child = null
    rmSync(join(dir, 'calls.jsonl'), { force: true })
    for (const f of readdirSync(process.env.XDG_RUNTIME_DIR as string))
      rmSync(join(process.env.XDG_RUNTIME_DIR as string, f))
  })

  const calls = (): { args: string[]; envFile?: { path: string; exists: boolean; mode: number; body: string } }[] =>
    existsSync(join(dir, 'calls.jsonl')) ? readRows(join(dir, 'calls.jsonl')) : []
  const configure = (cfg: object) => writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
  const spawnAgent = (env: Record<string, string>) => {
    child = Bun.spawn(['sleep', '30'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } })
    return child.pid
  }
  const agentGet = (agent: object) => ({
    result: {
      agent: {
        pane_id: 'w1:p1',
        workspace_id: 'w1',
        cwd: '/home/alice/now-here',
        terminal_title_stripped: 'Refactor the parser',
        ...agent,
      },
    },
  })

  test('Claude: same flags, transcript cwd, env through a 0600 file, split right', async () => {
    const { home } = claudeHome(TRANSCRIPT)
    const pid = spawnAgent({ CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "sk-'test'", CLAUDECODE: '1', OTHER: 'x' })
    configure({
      responses: {
        'agent get': agentGet({ agent: 'claude', agent_session: { value: SESSION } }),
        'pane process-info': {
          result: {
            process_info: {
              foreground_processes: [
                { pid: 1, name: 'zsh', argv: [] },
                { pid, name: 'claude', argv: ['claude', '--model', 'opus', '--resume', SESSION], cwd: '/x' },
              ],
            },
          },
        },
        'pane split': { result: { pane: { pane_id: 'w1:p7' }, source: { pane_id: 'w1:p1' } } },
      },
    })
    expect(await forkSession({ pane: 'w1:p1', mode: 'right', herdrBin })).toEqual({ pane: 'w1:p7' })
    const log = calls()
    expect(log.map(c => c.args.slice(0, 2).join(' '))).toEqual([
      'agent get',
      'pane process-info',
      'pane split',
      'pane run',
    ])
    expect(log[2]?.args).toEqual([
      'pane',
      'split',
      '--pane',
      'w1:p1',
      '--direction',
      'right',
      '--cwd',
      '/home/alice/project',
      '--focus',
    ])
    const run = log[3] as (typeof log)[number]
    expect(run.args[2]).toBe('w1:p7')
    const envFile = run.envFile as NonNullable<typeof run.envFile>
    expect(envFile.exists).toBe(true)
    expect(envFile.mode).toBe(0o600)
    expect(envFile.body).toBe(`export CLAUDE_CONFIG_DIR=${home}\nexport ANTHROPIC_API_KEY='sk-'"'"'test'"'"''\n`)
    expect(envFile.path.startsWith(process.env.XDG_RUNTIME_DIR as string)).toBe(true)
    // A whole fork resumes a copy cut at the newest message, so it has its id and history at once.
    const id = /--resume (\S+) -n/.exec(run.args[3] as string)?.[1] as string
    expect(id).not.toBe(SESSION)
    expect(run.args[3]).toBe(
      `. ${envFile.path}; rm -f ${envFile.path}; claude --model opus --resume ${id} -n 'Refactor the parser · fork'`,
    )
    const copy = readRows(join(home, 'projects', '-home-alice-project', `${id}.jsonl`))
    expect(copy.at(-1).uuid).toBe('u3')
    expect(copy.filter(r => r.uuid).length).toBe(TRANSCRIPT.filter(r => 'uuid' in r).length)
  })

  test('Claude whole fork of a session without messages falls back to --fork-session', async () => {
    const { home } = claudeHome([{ type: 'permission-mode', sessionId: SESSION, permissionMode: 'default' }])
    configure({
      responses: {
        'agent get': agentGet({ agent: 'claude', agent_session: { value: SESSION } }),
        'pane process-info': { result: { process_info: { foreground_processes: [] } } },
        'tab create': { result: { tab: { tab_id: 'w1:t3' }, root_pane: { pane_id: 'w1:p8' } } },
      },
    })
    await forkSession({ pane: 'w1:p1', mode: 'tab', herdrBin, claudeDirs: [home] })
    expect(calls()[3]?.args[3]).toBe(`claude --resume ${SESSION} --fork-session -n 'Refactor the parser · fork'`)
  })

  test('Claude with --at: resumes the cut copy in a new tab', async () => {
    const { home, path } = claudeHome(TRANSCRIPT)
    configure({
      responses: {
        'agent get': agentGet({ agent: 'claude', agent_session: { value: SESSION } }),
        'pane process-info': { result: { process_info: { foreground_processes: [] } } },
        'tab create': { result: { tab: { tab_id: 'w1:t3' }, root_pane: { pane_id: 'w1:p8' } } },
      },
    })
    const r = await forkSession({ pane: 'w1:p1', mode: 'tab', at: 'a1', herdrBin, claudeDirs: [home] })
    expect(r).toEqual({ pane: 'w1:p8' })
    const log = calls()
    expect(log[2]?.args).toEqual([
      'tab',
      'create',
      '--workspace',
      'w1',
      '--cwd',
      '/home/alice/project',
      '--label',
      'fork',
    ])
    const line = log[3]?.args[3] as string
    const id = /--resume (\S+) -n/.exec(line)?.[1] as string
    expect(line).toBe(`claude --resume ${id} -n 'Refactor the parser · fork'`)
    expect(existsSync(join(path, '..', `${id}.jsonl`))).toBe(true)
  })

  test('a failing pane run closes the new pane and removes the env file and the cut copy', async () => {
    const { home, path } = claudeHome(TRANSCRIPT)
    const pid = spawnAgent({ CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'sk-x' })
    configure({
      responses: {
        'agent get': agentGet({ agent: 'claude', agent_session: { value: SESSION } }),
        'pane process-info': {
          result: { process_info: { foreground_processes: [{ pid, name: 'claude', argv: ['claude'] }] } },
        },
        'pane split': { result: { pane: { pane_id: 'w1:p7' } } },
      },
      fail: { 'pane run': 'boom' },
    })
    await expect(forkSession({ pane: 'w1:p1', mode: 'down', at: 'a1', herdrBin })).rejects.toThrow(
      /herdr pane run: boom/,
    )
    const log = calls()
    expect(log.map(c => c.args.slice(0, 2).join(' '))).toEqual([
      'agent get',
      'pane process-info',
      'pane split',
      'pane run',
      'pane close',
    ])
    expect(log[4]?.args).toEqual(['pane', 'close', 'w1:p7'])
    const envFile = log[3]?.envFile
    expect(envFile?.exists).toBe(true)
    expect(existsSync(envFile?.path as string)).toBe(false)
    expect(readdirSync(join(path, '..'))).toEqual([`${SESSION}.jsonl`])
  })

  test('no env file is written when creating the pane fails', async () => {
    const { home } = claudeHome(TRANSCRIPT)
    const pid = spawnAgent({ CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'sk-x' })
    configure({
      responses: {
        'agent get': agentGet({ agent: 'claude', agent_session: { value: SESSION } }),
        'pane process-info': {
          result: { process_info: { foreground_processes: [{ pid, name: 'claude', argv: ['claude'] }] } },
        },
      },
      fail: { 'pane split': 'no room' },
    })
    await expect(forkSession({ pane: 'w1:p1', mode: 'right', herdrBin })).rejects.toThrow(/no room/)
    expect(readdirSync(process.env.XDG_RUNTIME_DIR as string)).toEqual([])
  })

  test('Codex: session from `codex resume <id>` argv; a process without argv does not crash', async () => {
    configure({
      responses: {
        'agent get': agentGet({ agent: 'codex', agent_session: null }),
        'pane process-info': {
          result: {
            process_info: {
              foreground_processes: [
                { pid: 999_999_999, name: 'zombie' },
                { pid: 999_999_998, name: 'codex', argv: ['codex', 'resume', CODEX_ID] },
              ],
            },
          },
        },
        'pane split': { result: { pane: { pane_id: 'w1:p5' } } },
      },
    })
    await forkSession({ pane: 'w1:p1', mode: 'down', herdrBin, codexHome: fresh('codex') })
    expect(calls()[3]?.args[3]).toBe(`codex fork ${CODEX_ID}`)
  })

  test('Codex: newest rollout in the cwd when argv has no id; --at resumes a cut copy', async () => {
    const home = fresh('codex')
    const src = rollout(home, CODEX_ID, CODEX_ROWS)
    configure({
      responses: {
        'agent get': agentGet({ agent: 'codex', cwd: '/home/alice/project' }),
        'pane process-info': { result: { process_info: { foreground_processes: [] } } },
        'pane split': { result: { pane: { pane_id: 'w1:p5' } } },
      },
    })
    await forkSession({ pane: 'w1:p1', mode: 'right', herdrBin, codexHome: home })
    expect(calls().at(-1)?.args[3]).toBe(`codex fork ${CODEX_ID}`)
    await forkSession({ pane: 'w1:p1', mode: 'right', herdrBin, codexHome: home, at: `${src}#${offsetAfter(src, 5)}` })
    expect(calls().at(-1)?.args[3]).toMatch(/^codex resume [0-9a-f-]{36}$/)
  })

  test('errors: not an agent, unexpected herdr output, no session, no workspace for a tab, no new pane', async () => {
    configure({ responses: { 'agent get': agentGet({ agent: 'pi' }) } })
    await expect(forkSession({ pane: 'w1:p1', mode: 'tab', herdrBin })).rejects.toMatchObject({ code: 'not_agent' })

    configure({ responses: { 'agent get': 'warning: old server\n{"result":{}}' } })
    await expect(forkSession({ pane: 'w1:p1', mode: 'tab', herdrBin })).rejects.toThrow(/unexpected output/)

    configure({
      responses: {
        'agent get': agentGet({ agent: 'claude' }),
        'pane process-info': { result: { process_info: { foreground_processes: [] } } },
      },
    })
    await expect(forkSession({ pane: 'w1:p1', mode: 'tab', herdrBin })).rejects.toMatchObject({ code: 'no_session' })

    configure({
      responses: {
        'agent get': agentGet({ agent: 'claude', agent_session: { value: SESSION }, workspace_id: undefined }),
        'pane process-info': { result: { process_info: { foreground_processes: [] } } },
      },
    })
    await expect(forkSession({ pane: 'w1:p1', mode: 'tab', herdrBin, claudeDirs: [] })).rejects.toThrow(
      /herdr reported no workspace/,
    )

    configure({
      responses: {
        'agent get': agentGet({ agent: 'claude', agent_session: { value: SESSION } }),
        'pane process-info': { result: { process_info: { foreground_processes: [] } } },
        'pane split': { result: { pane: { pane_id: 'w1:p1' } } },
      },
    })
    await expect(forkSession({ pane: 'w1:p1', mode: 'right', herdrBin, claudeDirs: [] })).rejects.toThrow(
      /could not find the new pane/,
    )
  })
})
