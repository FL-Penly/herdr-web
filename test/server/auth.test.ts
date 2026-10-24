import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  guard,
  isAuthed,
  isLoopback,
  isSameOrigin,
  loginUrl,
  needsAuth,
  presentedToken,
  readToken,
  resolveToken,
  safeEqual,
} from '../../src/server/auth.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwx'
const req = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`http://box:12500${path}`, { method, headers: { host: 'box:12500', ...headers } })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-web-auth-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('resolveToken', () => {
  test('creates a 0600 token file on first start and reuses it', () => {
    const configDir = join(dir, 'cfg')
    const first = resolveToken({ env: undefined, configDir, host: '127.0.0.1' })
    expect(first?.length).toBeGreaterThanOrEqual(16)
    expect(statSync(join(configDir, 'token')).mode & 0o777).toBe(0o600)
    expect(resolveToken({ env: undefined, configDir, host: '0.0.0.0' })).toBe(first)
  })

  test('regenerates an empty or whitespace token file instead of disabling auth', () => {
    writeFileSync(join(dir, 'token'), '  \n')
    const token = resolveToken({ env: undefined, configDir: dir, host: '0.0.0.0' })
    expect(token).toBeTruthy()
    expect(readFileSync(join(dir, 'token'), 'utf8')).toBe(token as string)
  })

  test('regenerates a too-short token file', () => {
    writeFileSync(join(dir, 'token'), 'short')
    expect(resolveToken({ env: undefined, configDir: dir, host: '127.0.0.1' })).not.toBe('short')
  })

  test('uses HERDR_WEB_TOKEN but rejects a weak one', () => {
    expect(resolveToken({ env: TOKEN, configDir: dir, host: '0.0.0.0' })).toBe(TOKEN)
    expect(() => resolveToken({ env: 'pw', configDir: dir, host: '127.0.0.1' })).toThrow(/at least/)
  })

  test('a token must fit a header and a WebSocket subprotocol', () => {
    expect(() => resolveToken({ env: 'with space and more chars', configDir: dir, host: '0.0.0.0' })).toThrow(
      /may only contain/,
    )
    expect(() => resolveToken({ env: 'abcdefghijklmnop,q', configDir: dir, host: '0.0.0.0' })).toThrow(/may only/)
    writeFileSync(join(dir, 'token'), 'abcdefghijklmnop/q=')
    expect(() => resolveToken({ env: undefined, configDir: dir, host: '127.0.0.1' })).toThrow(/may only contain/)
  })

  test('off is allowed on loopback only', () => {
    expect(resolveToken({ env: 'off', configDir: dir, host: '127.0.0.1' })).toBeNull()
    expect(resolveToken({ env: 'off', configDir: dir, host: 'localhost' })).toBeNull()
    expect(() => resolveToken({ env: 'off', configDir: dir, host: '0.0.0.0' })).toThrow(/loopback/)
  })
})

describe('readToken', () => {
  test('never creates a token file', () => {
    const configDir = join(dir, 'cfg')
    expect(readToken({ env: undefined, configDir, host: '127.0.0.1' })).toBeUndefined()
    expect(existsSync(configDir)).toBe(false)
    const token = resolveToken({ env: undefined, configDir, host: '127.0.0.1' })
    expect(readToken({ env: undefined, configDir, host: '127.0.0.1' })).toBe(token)
    expect(readToken({ env: TOKEN, configDir, host: '127.0.0.1' })).toBe(TOKEN)
    expect(readToken({ env: 'off', configDir, host: '127.0.0.1' })).toBeNull()
  })
})

test('isLoopback', () => {
  expect(['127.0.0.1', '127.1.2.3', 'localhost', '::1'].every(isLoopback)).toBe(true)
  expect(['0.0.0.0', '::', '192.168.1.2', '127.0.0.1.evil'].some(isLoopback)).toBe(false)
})

describe('credentials', () => {
  const ws = (protocols: string) => ({ upgrade: 'websocket', 'sec-websocket-protocol': protocols })

  test('a bearer header, or on a WebSocket handshake the bearer subprotocol', () => {
    expect(presentedToken(req('/api/thread', { authorization: `Bearer ${TOKEN}` }))).toBe(TOKEN)
    expect(presentedToken(req('/api/thread', { authorization: `bearer  ${TOKEN} ` }))).toBe(TOKEN)
    expect(presentedToken(req('/ws/state', ws(`herdr-web, bearer.${TOKEN}`)))).toBe(TOKEN)
    expect(presentedToken(req('/ws/state', ws('herdr-web')))).toBeNull()
    // Without an upgrade, a subprotocol header is just a header.
    expect(presentedToken(req('/api/thread', { 'sec-websocket-protocol': `bearer.${TOKEN}` }))).toBeNull()
  })

  test('cookies and query strings are not credentials any more', () => {
    expect(isAuthed(req('/api/thread', { cookie: `hw=${TOKEN}` }), TOKEN)).toBe(false)
    expect(isAuthed(req(`/api/thread?t=${TOKEN}`), TOKEN)).toBe(false)
    expect(isAuthed(req(`/ws/state?t=${TOKEN}`, { upgrade: 'websocket', cookie: `hw=${TOKEN}` }), TOKEN)).toBe(false)
  })

  test('isAuthed compares exactly; auth off lets everything through', () => {
    expect(isAuthed(req('/', { authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true)
    expect(isAuthed(req('/', { authorization: `Bearer ${TOKEN}x` }), TOKEN)).toBe(false)
    expect(isAuthed(req('/', { authorization: 'Bearer' }), TOKEN)).toBe(false)
    expect(isAuthed(req('/', { authorization: `Basic ${TOKEN}` }), TOKEN)).toBe(false)
    expect(isAuthed(req('/'), TOKEN)).toBe(false)
    expect(isAuthed(req('/'), null)).toBe(true)
  })

  test('safeEqual handles different lengths', () => {
    expect(safeEqual('a', 'a')).toBe(true)
    expect(safeEqual('a', 'ab')).toBe(false)
    expect(safeEqual('', TOKEN)).toBe(false)
  })

  test('only the API and the sockets need the token', () => {
    for (const path of ['/api/act', '/api/session', '/ws/state', '/ws/term']) expect(needsAuth(path)).toBe(true)
    for (const path of ['/', '/index.html', '/js/main.js', '/vendor/marked/x.js', '/sw.js', '/apix'])
      expect(needsAuth(path)).toBe(false)
  })
})

describe('origin', () => {
  test('absent Origin is allowed; only our own host matches', () => {
    expect(isSameOrigin(req('/'))).toBe(true)
    expect(isSameOrigin(req('/', { origin: 'http://box:12500' }))).toBe(true)
    expect(isSameOrigin(req('/', { origin: 'http://box:3000' }))).toBe(false)
    expect(isSameOrigin(req('/', { origin: 'null' }))).toBe(false)
    expect(isSameOrigin(req('/', { origin: 'https://web.example', 'x-forwarded-host': 'web.example' }))).toBe(true)
  })

  test('guard: 401 without the token, 403 for cross-origin writes and upgrades, pass otherwise', async () => {
    const authorization = `Bearer ${TOKEN}`
    const check = (r: Request) => guard(r, new URL(r.url), TOKEN)
    expect(check(req('/'))).toBeNull()
    expect(check(req('/js/main.js', { accept: 'text/html' }))).toBeNull()
    const api = check(req('/api/thread'))
    expect(api?.status).toBe(401)
    expect(await api?.json()).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(check(req('/ws/state', { upgrade: 'websocket' }))?.status).toBe(401)
    expect(check(req('/api/thread', { authorization }))).toBeNull()
    expect(check(req('/api/thread', { authorization, origin: 'http://box:3000' }))).toBeNull()
    expect(check(req('/api/act', { authorization, origin: 'http://box:3000' }, 'POST'))?.status).toBe(403)
    expect(check(req('/ws/term', { authorization, origin: 'http://box:3000', upgrade: 'websocket' }))?.status).toBe(403)
    expect(check(req('/api/act', { authorization, origin: 'http://box:12500' }, 'POST'))).toBeNull()
  })
})

test('loginUrl carries the token in the fragment, which is never sent to the server', () => {
  expect(loginUrl('http://h:1/', 'abc_DEF-123')).toBe('http://h:1/#t=abc_DEF-123')
  expect(loginUrl('http://h:1/', null)).toBe('http://h:1/')
})
