import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Server, WebSocketServeOptions } from 'bun'
import { type ServerDeps, type WSData, createFallback, createRoutes } from '../../src/server/routes.ts'

// A real Bun server over the real routes: what a browser on this origin, or a page on another port, can get.
const TOKEN = 'abcdefghijklmnopqrstuvwx'
let server: Server
let base: string

beforeAll(() => {
  const deps: ServerDeps = {
    token: TOKEN,
    statics: { page: async p => new Response(`page ${p}`), vendor: async p => new Response(`vendor ${p}`) },
    queries: {} as ServerDeps['queries'],
    act: async () => ({}),
    uploadDir: '/nonexistent',
    usage: { read: async () => ({ accounts: [] }) },
  }
  // bun-types 1.2 does not model `routes` next to `websocket` (see src/main.ts).
  const options: WebSocketServeOptions<WSData> & { routes: ReturnType<typeof createRoutes> } = {
    hostname: '127.0.0.1',
    port: 0,
    routes: createRoutes(deps),
    fetch: createFallback(deps),
    websocket: { open: ws => void ws.send('hello'), message() {} },
  }
  server = Bun.serve(options)
  base = `127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))

function connect(protocols: string[]): Promise<{ protocol: string; opened: boolean }> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://${base}/ws/state`, { protocols, headers: { origin: `http://${base}` } } as never)
    ws.onopen = () => {
      resolve({ protocol: ws.protocol, opened: true })
      ws.close()
    }
    ws.onerror = () => resolve({ protocol: '', opened: false })
  })
}

test('a WebSocket with the bearer subprotocol opens, and the answer never echoes the token', async () => {
  expect(await connect(['herdr-web', `bearer.${TOKEN}`])).toEqual({ protocol: 'herdr-web', opened: true })
  // Bun would pick the first offered protocol by itself; the server must name its own.
  expect(await connect([`bearer.${TOKEN}`, 'herdr-web'])).toEqual({ protocol: 'herdr-web', opened: true })
  expect((await connect(['herdr-web', 'bearer.not-the-token-at-all'])).opened).toBe(false)
  expect((await connect(['herdr-web'])).opened).toBe(false)
})

test('a handshake offering only the bearer entry is refused rather than answered with it', async () => {
  const res = await fetch(`http://${base}/ws/state`, {
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-protocol': `bearer.${TOKEN}`,
    },
  })
  expect(res.status).toBe(400)
  expect(res.headers.get('sec-websocket-protocol')).toBeNull()
})

test('nothing sets a cookie, so another port of this host never receives a credential', async () => {
  for (const path of ['/', `/?t=${TOKEN}`, '/js/main.js', '/api/session', '/api/nothing']) {
    const res = await fetch(`http://${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect([path, res.headers.get('set-cookie')]).toEqual([path, null])
  }
  const replayed = await fetch(`http://${base}/api/session`, { headers: { cookie: `hw=${TOKEN}` } })
  expect(replayed.status).toBe(401)
  const authed = await fetch(`http://${base}/api/session`, { headers: { authorization: `Bearer ${TOKEN}` } })
  expect(await authed.json()).toEqual({ ok: true })
})
