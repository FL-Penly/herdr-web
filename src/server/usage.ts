import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { UsageAccount, UsageReport, UsageWindow } from '../protocol.ts'

// Subscription limits of the Claude Code and Codex sign-ins on this machine, as their providers state them (the
// endpoints OpenUsage reads). Read only: a token is never refreshed, since both tools rotate refresh tokens and a
// refresh they did not make would sign them out. An expired sign-in says so; using the tool renews it.

/** A provider is asked at most this often; the browser asks only while the meter is on. */
export const USAGE_TTL_MS = 5 * 60_000
/** A refresh the user asked for, at most this often. */
export const USAGE_FORCE_MS = 30_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_BYTES = 1 << 20
const FIVE_HOURS = 5 * 3600
const SEVEN_DAYS = 7 * 86400
const USER_AGENT = 'herdr-web'

type Json = Record<string, unknown>
type Provider = UsageAccount['provider']

interface SignIn {
  provider: Provider
  /** Tells accounts apart: the same account found in two places counts once. */
  id: string
  label: string | null
  token: string
  expiresAt: number | null
  plan: string | null
  workspace?: string | null
}

export interface UsageDeps {
  home: string
  claudeHome: string
  codexHome: string
  platform: NodeJS.Platform
  fetch(url: string, init: RequestInit): Promise<Response>
  keychain(service: string): Promise<string | null>
  now(): number
}

const record = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function readJson(path: string): Json {
  try {
    if (statSync(path).size > MAX_BYTES) return {}
    return record(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

function parse(source: string | null): Json {
  try {
    return source ? record(JSON.parse(source)) : {}
  } catch {
    return {}
  }
}

function jwtClaims(token: string): Json {
  try {
    return record(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')))
  } catch {
    return {}
  }
}

const tokenId = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 16)

/** `~/<prefix>*` directories: where a second account of a tool usually lives. */
function siblings(home: string, prefix: string): string[] {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(prefix))
      .map(e => join(home, e.name))
  } catch {
    return []
  }
}

function claudeSignIn(credentials: Json, config: Json): SignIn | null {
  const oauth = record(credentials.claudeAiOauth)
  const token = text(oauth.accessToken)
  if (!token) return null
  const account = record(config.oauthAccount)
  return {
    provider: 'claude',
    id: text(account.accountUuid) ?? tokenId(token),
    label: text(account.emailAddress),
    token,
    expiresAt: num(oauth.expiresAt),
    plan: text(oauth.subscriptionType),
  }
}

async function claudeSignIns(deps: UsageDeps): Promise<SignIn[]> {
  const defaultDir = join(deps.home, '.claude')
  const dirs = [...new Set([deps.claudeHome, defaultDir, ...siblings(deps.home, '.claude-')])]
  const found: SignIn[] = []
  for (const dir of dirs) {
    // Claude Code keeps the default account's .claude.json beside the folder, the others' inside it.
    const config = readJson(dir === defaultDir ? join(deps.home, '.claude.json') : join(dir, '.claude.json'))
    let signIn = claudeSignIn(readJson(join(dir, '.credentials.json')), config)
    if (!signIn && deps.platform === 'darwin') {
      const service =
        dir === defaultDir
          ? 'Claude Code-credentials'
          : `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`
      signIn = claudeSignIn(parse(await deps.keychain(service)), config)
    }
    if (signIn) found.push(signIn)
  }
  return found
}

function codexSignIn(auth: Json): SignIn | null {
  const tokens = record(auth.tokens)
  const token = text(tokens.access_token)
  if (!token) return null
  const claims = jwtClaims(token)
  const openai = record(claims['https://api.openai.com/auth'])
  const workspace = text(tokens.account_id) ?? text(openai.chatgpt_account_id)
  const email =
    text(record(claims['https://api.openai.com/profile']).email) ?? text(jwtClaims(text(tokens.id_token) ?? '').email)
  const user = text(openai.chatgpt_user_id) ?? text(openai.user_id)
  const exp = num(claims.exp)
  return {
    provider: 'codex',
    // Limits are per person in a workspace: the same email in a team workspace is another plan.
    id: text(openai.chatgpt_account_user_id) ?? ([user, workspace].filter(Boolean).join('__') || tokenId(token)),
    label: email,
    token,
    expiresAt: exp === null ? null : exp * 1000,
    plan: text(openai.chatgpt_plan_type),
    workspace,
  }
}

async function codexSignIns(deps: UsageDeps): Promise<SignIn[]> {
  const homes = [deps.codexHome, join(deps.home, '.config', 'codex'), join(deps.home, '.codex')]
  const found: SignIn[] = []
  for (const home of new Set([...homes, ...siblings(deps.home, '.codex-')])) {
    const signIn = codexSignIn(readJson(join(home, 'auth.json')))
    if (signIn) found.push(signIn)
  }
  if (!found.length && deps.platform === 'darwin') {
    const signIn = codexSignIn(parse(await deps.keychain('Codex Auth')))
    if (signIn) found.push(signIn)
  }
  return found
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}`)
  }
}

function retryAfter(header: string | null, now: number): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

async function requestJson(deps: UsageDeps, url: string, headers: Record<string, string>): Promise<Json> {
  const response = await deps.fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new HttpError(response.status, retryAfter(response.headers.get('retry-after'), deps.now()))
  }
  const body = await response.text()
  if (body.length > MAX_BYTES) throw new Error('answer too large')
  return record(JSON.parse(body))
}

const isoTime = (v: unknown): string | null => {
  const s = text(v)
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null
}
const percent = (v: number) => Math.max(0, Math.min(100, Math.round(v * 10) / 10))

function kindOf(seconds: number | null): UsageWindow['kind'] {
  if (seconds !== null && seconds >= SEVEN_DAYS - 3600) return 'week'
  return 'session'
}

function claudeWindow(value: unknown, kind: UsageWindow['kind'], scope: string | null): UsageWindow | null {
  const w = record(value)
  const used = num(w.utilization)
  return used === null ? null : { kind, scope, usedPercent: percent(used), resetsAt: isoTime(w.resets_at) }
}

async function readClaude(deps: UsageDeps, signIn: SignIn): Promise<UsageWindow[]> {
  const body = await requestJson(deps, 'https://api.anthropic.com/api/oauth/usage', {
    authorization: `Bearer ${signIn.token}`,
    accept: 'application/json',
    'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': USER_AGENT,
  })
  const windows = [
    claudeWindow(body.five_hour, 'session', null),
    claudeWindow(body.seven_day, 'week', null),
    claudeWindow(body.seven_day_opus, 'week', 'Opus'),
    claudeWindow(body.seven_day_sonnet, 'week', 'Sonnet'),
  ].filter((w): w is UsageWindow => w !== null)
  // A model with a weekly limit of its own may be only in `limits`; the flat fields win.
  for (const limit of (Array.isArray(body.limits) ? body.limits : []).map(record)) {
    const model = text(record(record(limit.scope).model).display_name)
    const used = num(limit.percent)
    if (limit.kind !== 'weekly_scoped' || !model || used === null || windows.some(w => w.scope === model)) continue
    windows.push({ kind: 'week', scope: model, usedPercent: percent(used), resetsAt: isoTime(limit.resets_at) })
  }
  return windows
}

function codexWindow(value: unknown, now: number): UsageWindow | null {
  const w = record(value)
  const used = num(w.used_percent)
  if (used === null) return null
  const after = num(w.reset_after_seconds)
  const resetAt = num(w.reset_at)
  const resetsAt =
    resetAt !== null
      ? new Date(resetAt * 1000).toISOString()
      : after === null
        ? null
        : new Date(now + after * 1000).toISOString()
  return { kind: kindOf(num(w.limit_window_seconds) ?? FIVE_HOURS), scope: null, usedPercent: percent(used), resetsAt }
}

async function readCodex(deps: UsageDeps, signIn: SignIn): Promise<{ plan: string | null; windows: UsageWindow[] }> {
  const body = await requestJson(deps, 'https://chatgpt.com/backend-api/wham/usage', {
    authorization: `Bearer ${signIn.token}`,
    accept: 'application/json',
    'user-agent': USER_AGENT,
    ...(signIn.workspace ? { 'chatgpt-account-id': signIn.workspace } : {}),
  })
  const limits = record(body.rate_limit)
  const now = deps.now()
  const windows = [codexWindow(limits.primary_window, now), codexWindow(limits.secondary_window, now)].filter(
    (w): w is UsageWindow => w !== null,
  )
  return { plan: text(body.plan_type), windows }
}

interface Entry {
  account: UsageAccount
  at: number
  /** Not asked again before this (a 429's Retry-After). */
  until: number
}

/** Each sign-in's limits, asked of its provider at most every USAGE_TTL_MS. */
export function createUsage(deps: UsageDeps) {
  const cache = new Map<string, Entry>()
  // A question already on its way: browsers asking at the same moment share its answer.
  const asking = new Map<string, Promise<UsageAccount>>()

  function readOne(signIn: SignIn, force: boolean): Promise<UsageAccount> {
    const key = `${signIn.provider}:${signIn.id}`
    const now = deps.now()
    const cached = cache.get(key)
    if (cached && now < cached.until) return Promise.resolve(cached.account)
    if (cached && now - cached.at < (force ? USAGE_FORCE_MS : USAGE_TTL_MS)) return Promise.resolve(cached.account)
    let pending = asking.get(key)
    if (!pending) {
      pending = ask(signIn, key, cached).finally(() => asking.delete(key))
      asking.set(key, pending)
    }
    return pending
  }

  async function ask(signIn: SignIn, key: string, cached: Entry | undefined): Promise<UsageAccount> {
    const now = deps.now()
    const base = { provider: signIn.provider, label: signIn.label, plan: signIn.plan }
    let account: UsageAccount
    let until = 0
    if (signIn.expiresAt !== null && signIn.expiresAt <= now) {
      account = { ...base, windows: [], problem: 'expired' }
    } else {
      try {
        if (signIn.provider === 'claude') account = { ...base, windows: await readClaude(deps, signIn) }
        else {
          const { plan, windows } = await readCodex(deps, signIn)
          account = { ...base, plan: plan ?? base.plan, windows }
        }
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 0
        const problem = status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'expired' : 'failed'
        if (status === 429) until = now + ((err as HttpError).retryAfterMs ?? USAGE_TTL_MS)
        // What the provider said last stays shown while it cannot be asked.
        account = { ...base, windows: cached?.account.windows ?? [], problem }
      }
    }
    cache.set(key, { account, at: now, until })
    return account
  }

  return {
    async read(force = false): Promise<UsageReport> {
      const signIns = [...(await claudeSignIns(deps)), ...(await codexSignIns(deps))]
      const unique = [...new Map(signIns.map(s => [`${s.provider}:${s.id}`, s])).values()]
      return { accounts: await Promise.all(unique.map(s => readOne(s, force))) }
    },
  }
}

/** The macOS keychain's secret for `service`, or null; never prompts past a few seconds. */
export async function readKeychain(service: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['security', 'find-generic-password', '-s', service, '-w'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const timer = setTimeout(() => proc.kill(), 5000)
    const out = await new Response(proc.stdout).text()
    clearTimeout(timer)
    return (await proc.exited) === 0 && out.length <= MAX_BYTES ? out.trim() : null
  } catch {
    return null
  }
}
