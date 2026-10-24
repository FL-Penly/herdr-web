import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'bun'
import { UserError } from '../../src/server/http.ts'
import type { Queries } from '../../src/server/queries.ts'
import { type ServerDeps, createFallback, createRoutes } from '../../src/server/routes.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwx'
const files = mkdtempSync(join(tmpdir(), 'routes-files-'))
afterAll(() => rmSync(files, { recursive: true, force: true }))
const ORIGIN = 'http://box:12500'

function setup() {
  const acts: unknown[] = []
  const upgrades: unknown[] = []
  const queries: Queries = {
    thread: async (pane, turns) => ({ turns: [], more: turns, meta: { path: pane } }) as never,
    diff: async () => {
      throw new UserError('not_a_repo', 'not a repo')
    },
    models: kind => ({ models: [{ id: kind, label: kind, efforts: [] }], default: { model: '', effort: '' } }),
    commands: () => ({ commands: [], skills: [] }),
    commandOutput: async (_, command) => ({ text: command }),
    paneText: async pane => ({ text: `text of ${pane}` }),
    sessions: async () => ({ sessions: [] }),
    dirs: workspace => ({ recent: [workspace ?? 'any'], home: '/home/alice' }),
    complete: path => ({ dirs: [path] }),
    filePath: (_, path) => join(files, path),
  }
  const deps: ServerDeps = {
    token: TOKEN,
    statics: { page: async p => new Response(`page ${p}`), vendor: async p => new Response(`vendor ${p}`) },
    queries,
    act: async body => {
      acts.push(body)
      return { pane: 'w1:p9' }
    },
    uploadDir: '/nonexistent',
    usage: {
      read: async force => ({ accounts: force ? [] : [{ provider: 'claude', label: null, plan: null, windows: [] }] }),
    },
  }
  const server = {
    upgrade: (_: Request, o: { data: unknown; headers?: unknown }) => upgrades.push(o) > 0,
  } as unknown as Server
  const routes = createRoutes(deps)
  const fallback = createFallback(deps)
  const call = (
    route: keyof typeof routes,
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; authed?: boolean } = {},
  ) => {
    const headers = new Headers(init.headers)
    headers.set('host', 'box:12500')
    if (init.authed !== false) headers.set('authorization', `Bearer ${TOKEN}`)
    return routes[route](new Request(`${ORIGIN}${path}`, { ...init, headers }), server)
  }
  const fetchFallback = (path: string, headers: Record<string, string> = {}) =>
    fallback(new Request(`${ORIGIN}${path}`, { headers: { host: 'box:12500', ...headers } }), server)
  return { call, fetchFallback, acts, upgrades }
}

const json = { 'content-type': 'application/json' }

describe('/api/act', () => {
  test('dispatches a JSON body and wraps the result', async () => {
    const { call, acts } = setup()
    const res = await call('/api/act', '/api/act', {
      method: 'POST',
      headers: json,
      body: '{"op":"ack","pane":"w1:p1"}',
    })
    expect(await res.json()).toEqual({ ok: true, pane: 'w1:p9' })
    expect(acts).toEqual([{ op: 'ack', pane: 'w1:p1' }])
  })

  test('requires the token, our Origin, POST and a JSON content type', async () => {
    const { call, acts } = setup()
    const body = '{"op":"ack","pane":"w1:p1"}'
    expect((await call('/api/act', '/api/act', { method: 'POST', headers: json, body, authed: false })).status).toBe(
      401,
    )
    const cookie = { ...json, cookie: `hw=${TOKEN}` }
    expect((await call('/api/act', '/api/act', { method: 'POST', headers: cookie, body, authed: false })).status).toBe(
      401,
    )
    const cross = await call('/api/act', '/api/act', {
      method: 'POST',
      headers: { ...json, origin: 'http://box:3000' },
      body,
    })
    expect(cross.status).toBe(403)
    expect((await call('/api/act', '/api/act')).status).toBe(405)
    const plain = await call('/api/act', '/api/act', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
    })
    expect(plain.status).toBe(415)
    expect(await plain.json()).toMatchObject({ ok: false, code: 'unsupported_media_type' })
    const broken = await call('/api/act', '/api/act', { method: 'POST', headers: json, body: '{' })
    expect(await broken.json()).toMatchObject({ ok: false, code: 'bad_request' })
    expect(acts).toEqual([])
  })
})

describe('queries', () => {
  test('validate parameters and map errors to the envelope', async () => {
    const { call } = setup()
    expect(await (await call('/api/thread', '/api/thread?pane=w1:p1&turns=99999')).json()).toMatchObject({
      ok: true,
      more: 1000,
    })
    expect(await (await call('/api/session', '/api/session')).json()).toEqual({ ok: true })
    const anon = await call('/api/session', '/api/session', { authed: false })
    expect([anon.status, await anon.json()]).toEqual([401, expect.objectContaining({ code: 'unauthorized' })])
    expect((await call('/api/thread', '/api/thread?pane=--help')).status).toBe(400)
    const diff = await call('/api/diff', '/api/diff?pane=w1:p1')
    expect(diff.status).toBe(400)
    expect(await diff.json()).toEqual({ ok: false, error: 'not a repo', code: 'not_a_repo' })
    expect((await call('/api/models', '/api/models?kind=gemini')).status).toBe(400)
    expect(await (await call('/api/models', '/api/models?kind=codex')).json()).toMatchObject({ ok: true })
    expect(await (await call('/api/command-output', '/api/command-output?pane=w1:p1&command=/status')).json()).toEqual({
      ok: true,
      text: '/status',
    })
    expect((await call('/api/command-output', '/api/command-output?pane=w1:p1&command=status')).status).toBe(400)
    expect(await (await call('/api/usage', '/api/usage')).json()).toMatchObject({
      ok: true,
      accounts: [{ provider: 'claude' }],
    })
    expect(await (await call('/api/usage', '/api/usage?refresh=1')).json()).toEqual({ ok: true, accounts: [] })
    expect(await (await call('/api/pane-text', '/api/pane-text?pane=w1:p1')).json()).toEqual({
      ok: true,
      text: 'text of w1:p1',
    })
    expect((await call('/api/pane-text', '/api/pane-text?pane=a%20b')).status).toBe(400)
    expect(await (await call('/api/dirs', '/api/dirs?workspace=w1')).json()).toEqual({
      ok: true,
      recent: ['w1'],
      home: '/home/alice',
    })
    expect(await (await call('/api/dirs', '/api/dirs')).json()).toEqual({
      ok: true,
      recent: ['any'],
      home: '/home/alice',
    })
    expect((await call('/api/dirs', '/api/dirs?workspace=-x')).status).toBe(400)
    expect(await (await call('/api/complete', '/api/complete?path=~/src/he')).json()).toEqual({
      ok: true,
      dirs: ['~/src/he'],
    })
    expect((await call('/api/complete', '/api/complete?path=src')).status).toBe(400)
  })
})

describe('pages and fallback', () => {
  test('the app shell and its assets need no token: they hold no secrets', async () => {
    const { call, fetchFallback } = setup()
    expect(await (await call('/', '/', { authed: false })).text()).toBe('page /')
    expect(await (await call('/vendor/*', '/vendor/marked/lib/marked.esm.js', { authed: false })).text()).toBe(
      'vendor /vendor/marked/lib/marked.esm.js',
    )
    for (const path of ['/js/main.js', '/css/app.css', '/manifest.webmanifest', '/icons/icon-192.png', '/sw.js'])
      expect(await (await fetchFallback(path))?.text()).toBe(`page ${path}`)
    expect(await (await fetchFallback('/favicon.ico'))?.text()).toBe('page /favicon.svg')
  })

  test('no response sets a cookie, and a login link in the query string does nothing', async () => {
    const { call } = setup()
    const res = await call('/', `/?t=${TOKEN}`, { authed: false })
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await res.text()).toBe('page /')
  })

  test('upgrades /ws/* with the bearer subprotocol, answering with herdr-web only', async () => {
    const { fetchFallback, upgrades } = setup()
    const ws = { upgrade: 'websocket', origin: ORIGIN, 'sec-websocket-protocol': `herdr-web, bearer.${TOKEN}` }
    expect(await fetchFallback('/ws/state', ws)).toBeUndefined()
    expect(await fetchFallback('/ws/term?pane=w1:p2&cols=5000&rows=abc', ws)).toBeUndefined()
    expect(await fetchFallback('/ws/term?pane=w1:p2&cols=90&rows=30&mode=control', ws)).toBeUndefined()
    expect(upgrades).toEqual([
      { data: { kind: 'state' }, headers: { 'sec-websocket-protocol': 'herdr-web' } },
      {
        data: { kind: 'term', pane: 'w1:p2', cols: 400, rows: 40, opening: 'observe', generation: 0 },
        headers: { 'sec-websocket-protocol': 'herdr-web' },
      },
      {
        data: { kind: 'term', pane: 'w1:p2', cols: 90, rows: 30, opening: 'control', generation: 0 },
        headers: { 'sec-websocket-protocol': 'herdr-web' },
      },
    ])
    expect((await fetchFallback('/ws/term?pane=w1:p2', { ...ws, origin: 'http://evil.example' }))?.status).toBe(403)
    expect((await fetchFallback('/ws/term?pane=-x', ws))?.status).toBe(400)
    for (const anon of [
      { upgrade: 'websocket', origin: ORIGIN } as Record<string, string>,
      { upgrade: 'websocket', origin: ORIGIN, cookie: `hw=${TOKEN}` },
      { upgrade: 'websocket', origin: ORIGIN, 'sec-websocket-protocol': 'herdr-web, bearer.wrong-token-value' },
    ])
      expect((await fetchFallback('/ws/state', anon))?.status).toBe(401)
    expect((await fetchFallback(`/ws/state?t=${TOKEN}`, { upgrade: 'websocket', origin: ORIGIN }))?.status).toBe(401)
    expect(upgrades).toHaveLength(3)
  })

  test('unknown API paths need the token, then are JSON 404s; the rest is static', async () => {
    const { fetchFallback } = setup()
    expect((await fetchFallback('/api/screen'))?.status).toBe(401)
    const res = await fetchFallback('/api/screen', { authorization: `Bearer ${TOKEN}` })
    expect(res?.status).toBe(404)
    expect(await res?.json()).toMatchObject({ ok: false, code: 'not_found' })
    expect(await (await fetchFallback('/js/main.js'))?.text()).toBe('page /js/main.js')
  })
})

describe('/api/file', () => {
  test("serves a file's bytes, never as something that runs, and errors as JSON", async () => {
    writeFileSync(join(files, 'page.html'), '<script>alert(1)</script>')
    const { call } = setup()
    const res = await call('/api/file', '/api/file?pane=w1:p1&path=page.html')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<script>alert(1)</script>')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(decodeURIComponent(res.headers.get('x-file-path') ?? '')).toBe(join(files, 'page.html'))

    const missing = await call('/api/file', '/api/file?pane=w1:p1&path=nope.txt')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ ok: false, code: 'file_not_found' })
    const dir = await call('/api/file', '/api/file?pane=w1:p1&path=.')
    expect(await dir.json()).toMatchObject({ code: 'not_a_file' })
    expect((await call('/api/file', '/api/file?pane=w1:p1&path=page.html', { authed: false })).status).toBe(401)
    expect((await call('/api/file', '/api/file?pane=a%20b&path=page.html')).status).toBe(400)
  })
})
