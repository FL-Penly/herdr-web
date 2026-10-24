import type { Server } from 'bun'
import { MAX_TURNS } from '../agents/thread.ts'
import { HERDR_ID } from '../herdr.ts'
import type { AgentKind, UsageReport } from '../protocol.ts'
import { WS_PROTOCOL, guard, offeredProtocols } from './auth.ts'
import { fileResponse } from './files.ts'
import { UserError, errorResponse, fail, wrap } from './http.ts'
import type { Queries } from './queries.ts'
import { type StaticFiles, notFound } from './static.ts'
import { type TermData, clampSize } from './terminal.ts'
import { saveUpload } from './upload.ts'

export type WSData = { kind: 'state' } | TermData

export interface ServerDeps {
  /** null: auth is off (loopback only). */
  token: string | null
  statics: StaticFiles
  queries: Queries
  /** POST /api/act. */
  act(body: unknown): Promise<object>
  uploadDir: string
  /** GET /api/usage: the subscription limits of the sign-ins on this machine; `force` asks the providers again. */
  usage: { read(force: boolean): Promise<UsageReport> }
}

type Handler = (req: Request, url: URL, server: Server) => Response | Promise<Response>

const COMMAND = /^\/[\w:.-]{1,64}$/
const DIR_PATH = /^[/~][^\0\n\r]{0,4095}$/

function param(url: URL, name: string, pattern?: RegExp): string {
  const value = url.searchParams.get(name) ?? ''
  if (!value || (pattern && !pattern.test(value)))
    throw new UserError('bad_request', `Query parameter ${name} is invalid`)
  return value
}

function kindParam(url: URL): AgentKind {
  const kind = url.searchParams.get('kind') ?? 'claude'
  if (kind !== 'claude' && kind !== 'codex') throw new UserError('bad_request', 'kind must be claude or codex')
  return kind
}

function turnsParam(url: URL): number {
  const n = Number(url.searchParams.get('turns'))
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), MAX_TURNS) : 30
}

async function readJsonBody(req: Request): Promise<unknown> {
  // A cross-site form or `fetch(..., {mode: 'no-cors'})` can only send simple content types; requiring JSON
  // forces a CORS preflight that this server never grants.
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? ''))
    throw new UserError('unsupported_media_type', 'Content-Type must be application/json', 415)
  try {
    return await req.json()
  } catch {
    throw new UserError('bad_request', 'The body is not valid JSON')
  }
}

/** Every handler checks the token (for /api/ and /ws/) and, for writes and upgrades, the Origin first. */
function guarded(token: string | null, handler: Handler) {
  return (req: Request, server: Server): Response | Promise<Response> => {
    const url = new URL(req.url)
    return guard(req, url, token) ?? handler(req, url, server)
  }
}

export function createRoutes(d: ServerDeps) {
  const api = (method: 'GET' | 'POST', run: (req: Request, url: URL) => Promise<object> | object) =>
    guarded(d.token, (req, url) =>
      req.method === method ? wrap(async () => run(req, url)) : fail(405, 'method_not_allowed', `Use ${method}`),
    )
  const page = (serve: (url: URL) => Promise<Response>) =>
    guarded(d.token, (req, url) =>
      req.method === 'GET' || req.method === 'HEAD' ? serve(url) : new Response(null, { status: 405 }),
    )

  return {
    '/': page(() => d.statics.page('/')),
    '/vendor/*': page(url => d.statics.vendor(url.pathname)),
    '/api/session': api('GET', () => ({})),
    '/api/act': api('POST', async req => d.act(await readJsonBody(req))),
    '/api/upload': api('POST', (req, url) => saveUpload(req, d.uploadDir, url.searchParams.get('name'))),
    '/api/thread': api('GET', (_, url) => d.queries.thread(param(url, 'pane', HERDR_ID), turnsParam(url))),
    '/api/diff': api('GET', (_, url) => d.queries.diff(param(url, 'pane', HERDR_ID))),
    '/api/models': api('GET', (_, url) => d.queries.models(kindParam(url))),
    '/api/commands': api('GET', (_, url) => d.queries.commands(kindParam(url), url.searchParams.get('cwd') ?? '')),
    '/api/dirs': api('GET', (_, url) =>
      d.queries.dirs(url.searchParams.has('workspace') ? param(url, 'workspace', HERDR_ID) : null),
    ),
    '/api/complete': api('GET', (_, url) => d.queries.complete(param(url, 'path', DIR_PATH))),
    // Raw bytes, not the JSON envelope; errors still come as one.
    '/api/file': guarded(d.token, (req, url) => {
      if (req.method !== 'GET') return fail(405, 'method_not_allowed', 'Use GET')
      try {
        return fileResponse(d.queries.filePath(param(url, 'pane', HERDR_ID), param(url, 'path')))
      } catch (err) {
        return errorResponse(err)
      }
    }),
    '/api/usage': api('GET', (_, url) => d.usage.read(url.searchParams.get('refresh') === '1')),
    '/api/pane-text': api('GET', (_, url) => d.queries.paneText(param(url, 'pane', HERDR_ID))),
    '/api/sessions': api('GET', (_, url) => d.queries.sessions(param(url, 'pane', HERDR_ID))),
    '/api/command-output': api('GET', (_, url) =>
      d.queries.commandOutput(param(url, 'pane', HERDR_ID), param(url, 'command', COMMAND)),
    ),
  }
}

/**
 * Everything the routes table does not match: WebSocket upgrades, files under public/, and 404s.
 * Returns undefined after a successful upgrade, as Bun expects.
 */
export function createFallback(d: Pick<ServerDeps, 'token' | 'statics'>) {
  return async (req: Request, server: Server): Promise<Response | undefined> => {
    const url = new URL(req.url)
    const denied = guard(req, url, d.token)
    if (denied) return denied
    if (url.pathname === '/ws/state' || url.pathname === '/ws/term') {
      const data: WSData =
        url.pathname === '/ws/state'
          ? { kind: 'state' }
          : {
              kind: 'term',
              pane: url.searchParams.get('pane') ?? '',
              ...clampSize(url.searchParams.get('cols'), url.searchParams.get('rows')),
              opening: url.searchParams.get('mode') === 'control' ? 'control' : 'observe',
              generation: 0,
            }
      if (data.kind === 'term' && !HERDR_ID.test(data.pane)) return fail(400, 'bad_request', 'pane is invalid')
      // Browsers drop a socket whose server picks none of the offered subprotocols, and Bun would otherwise
      // answer with the first one offered, which may be `bearer.<token>`: always name the fixed one, and
      // refuse a handshake that offers protocols but not ours.
      const offered = offeredProtocols(req)
      if (offered.length > 0 && !offered.includes(WS_PROTOCOL))
        return fail(400, 'bad_request', `WebSocket subprotocol ${WS_PROTOCOL} expected`)
      const headers = offered.length > 0 ? { 'sec-websocket-protocol': WS_PROTOCOL } : undefined
      return server.upgrade<WSData>(req, { data, headers })
        ? undefined
        : new Response('WebSocket upgrade expected\n', { status: 400 })
    }
    if (url.pathname.startsWith('/api/')) return fail(404, 'not_found', `No endpoint ${url.pathname}`)
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound()
    // Browsers ask for it whatever the page links to.
    if (url.pathname === '/favicon.ico') return d.statics.page('/favicon.svg')
    return d.statics.page(url.pathname)
  }
}
