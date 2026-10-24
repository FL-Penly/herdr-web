import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './http.ts'

const MIN_TOKEN_LENGTH = 16
/**
 * The token travels in an `Authorization` header and as a WebSocket subprotocol (`bearer.<token>`), which
 * must be an HTTP token; base64url (what herdr-web generates) plus `.` and `~` fits both and URLs.
 */
const TOKEN_CHARS = /^[\w.~-]+$/
/** The subprotocol the browser offers with its token and the server answers with, never echoing the token. */
export const WS_PROTOCOL = 'herdr-web'
const WS_BEARER = 'bearer.'

interface TokenSource {
  /** `HERDR_WEB_TOKEN`: a fixed token, `off`, or unset. */
  env: string | undefined
  configDir: string
  host: string
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)
}

export function tokenFile(configDir: string): string {
  return join(configDir, 'token')
}

function checkChars(token: string, where: string): string {
  if (!TOKEN_CHARS.test(token))
    throw new Error(`${where} may only contain letters, digits and - _ . ~ (it is sent as an HTTP header)`)
  return token
}

/**
 * The access token without creating one: null when auth is off, undefined when there is no usable token
 * file yet. `off` is refused unless the server only listens on loopback.
 */
export function readToken({ env, configDir, host }: TokenSource): string | null | undefined {
  if (env === 'off') {
    if (!isLoopback(host)) throw new Error(`HERDR_WEB_TOKEN=off is only allowed on a loopback host, not ${host}`)
    return null
  }
  if (env) {
    if (env.length < MIN_TOKEN_LENGTH)
      throw new Error(`HERDR_WEB_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`)
    return checkChars(env, 'HERDR_WEB_TOKEN')
  }
  let token = ''
  try {
    token = readFileSync(tokenFile(configDir), 'utf8').trim()
  } catch {}
  return token.length >= MIN_TOKEN_LENGTH ? checkChars(token, tokenFile(configDir)) : undefined
}

/** The access token, or null when auth is off. An empty or short token file is replaced, never read as "no auth". */
export function resolveToken(src: TokenSource): string | null {
  const existing = readToken(src)
  if (existing !== undefined) return existing
  const file = tokenFile(src.configDir)
  const token = randomBytes(24).toString('base64url')
  mkdirSync(src.configDir, { recursive: true, mode: 0o700 })
  writeFileSync(file, token, { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}

// Hashing first makes the comparison constant-time regardless of the guessed length.
export function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(digest(a), digest(b))
}

export function offeredProtocols(req: Request): string[] {
  return (req.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
}

/**
 * The token a request presents: `Authorization: Bearer <token>`, or for a WebSocket handshake (browsers
 * cannot set headers there) the `bearer.<token>` subprotocol. Nothing else counts: no cookie, which a
 * browser would also send to every other port of this host, and no query string, which ends up in logs.
 */
export function presentedToken(req: Request): string | null {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  if (bearer) return bearer
  if (req.headers.get('upgrade') === null) return null
  const offered = offeredProtocols(req).find(p => p.startsWith(WS_BEARER))
  return offered ? offered.slice(WS_BEARER.length) : null
}

export function isAuthed(req: Request, token: string | null): boolean {
  if (token === null) return true
  const given = presentedToken(req)
  return given !== null && safeEqual(given, token)
}

/**
 * Defense in depth for writes and upgrades: the token is not ambient (no cookie), so another page cannot
 * replay it, but a request from another origin is refused anyway. A missing Origin (curl) is allowed.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  const own = [req.headers.get('host'), req.headers.get('x-forwarded-host')]
  return own.some(h => h !== null && h.toLowerCase() === host.toLowerCase())
}

/** Only the API and the sockets are private; the app shell and its assets hold no secrets. */
export function needsAuth(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith('/ws/')
}

/** Null when the request may proceed; otherwise the 401/403 to send (JSON under /api/). */
export function guard(req: Request, url: URL, token: string | null): Response | null {
  const api = url.pathname.startsWith('/api/')
  const upgrade = req.headers.get('upgrade') !== null
  const write = req.method !== 'GET' && req.method !== 'HEAD'
  if ((upgrade || write) && !isSameOrigin(req))
    return api ? fail(403, 'forbidden', 'Cross-origin request refused') : text(403, 'Cross-origin request refused.')
  if (!needsAuth(url.pathname) || isAuthed(req, token)) return null
  if (api) return fail(401, 'unauthorized', 'Access token required')
  return text(401, 'Access token required.')
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/** The link `bun run url` prints. The token is in the fragment, which browsers never send to a server or proxy. */
export function loginUrl(base: string, token: string | null): string {
  return token ? `${base}#t=${token}` : base
}
