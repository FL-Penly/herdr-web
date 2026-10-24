import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { USAGE_FORCE_MS, USAGE_TTL_MS, type UsageDeps, createUsage } from '../../src/server/usage.ts'

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
const NOW = Date.parse('2026-10-24T08:00:00Z')

let home: string
let clock: number
let calls: { url: string; headers: Record<string, string> }[]
let answers: Record<string, () => Response>

function deps(over: Partial<UsageDeps> = {}): UsageDeps {
  return {
    home,
    claudeHome: join(home, '.claude'),
    codexHome: join(home, '.codex'),
    platform: 'linux',
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string> })
      const answer = Object.entries(answers).find(([host]) => url.includes(host))?.[1]
      return answer ? answer() : new Response('', { status: 500 })
    },
    keychain: async () => null,
    now: () => clock,
    ...over,
  }
}

function write(path: string, value: object) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

const claudeSignIn = (dir: string, token = 'claude-token', expiresAt = NOW + 3600_000) =>
  write(join(dir, '.credentials.json'), { claudeAiOauth: { accessToken: token, expiresAt, subscriptionType: 'max' } })

const claudeAnswer = () =>
  Response.json({
    five_hour: { utilization: 42.25, resets_at: '2026-10-24T10:00:00Z' },
    seven_day: { utilization: 81, resets_at: '2026-10-28T00:00:00Z' },
    seven_day_opus: null,
    limits: [
      {
        kind: 'weekly_scoped',
        scope: { model: { display_name: 'Fable' } },
        percent: 12,
        resets_at: '2026-10-28T00:00:00Z',
      },
    ],
  })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'usage-'))
  clock = NOW
  calls = []
  answers = { 'api.anthropic.com': claudeAnswer }
})

describe('usage', () => {
  test('nothing signed in: no accounts, nobody asked', async () => {
    write(join(home, '.claude', '.credentials.json'), { mcpOAuth: { figma: { accessToken: 'mcp' } } })
    expect(await createUsage(deps()).read()).toEqual({ accounts: [] })
    expect(calls).toEqual([])
  })

  test('a Claude sign-in: its email, plan and every limit, with the token sent only to Anthropic', async () => {
    claudeSignIn(join(home, '.claude'))
    write(join(home, '.claude.json'), { oauthAccount: { accountUuid: 'u1', emailAddress: 'a@example.com' } })
    const { accounts } = await createUsage(deps()).read()
    expect(accounts).toEqual([
      {
        provider: 'claude',
        label: 'a@example.com',
        plan: 'max',
        windows: [
          { kind: 'session', scope: null, usedPercent: 42.3, resetsAt: '2026-10-24T10:00:00.000Z' },
          { kind: 'week', scope: null, usedPercent: 81, resetsAt: '2026-10-28T00:00:00.000Z' },
          { kind: 'week', scope: 'Fable', usedPercent: 12, resetsAt: '2026-10-28T00:00:00.000Z' },
        ],
      },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(calls[0].headers.authorization).toBe('Bearer claude-token')
  })

  test('an expired sign-in says so and is not sent anywhere', async () => {
    claudeSignIn(join(home, '.claude'), 'old', NOW - 1)
    const { accounts } = await createUsage(deps()).read()
    expect(accounts[0]).toMatchObject({ provider: 'claude', problem: 'expired', windows: [] })
    expect(calls).toEqual([])
  })

  test('the provider is asked at most every few minutes; a refresh at most every 30 seconds', async () => {
    claudeSignIn(join(home, '.claude'))
    const usage = createUsage(deps())
    await usage.read()
    clock += 10_000
    await usage.read(true)
    await usage.read()
    expect(calls).toHaveLength(1)
    clock += USAGE_FORCE_MS
    await usage.read(true)
    expect(calls).toHaveLength(2)
    clock += USAGE_TTL_MS
    await usage.read()
    expect(calls).toHaveLength(3)
  })

  test('a 429 keeps the last limits and waits as long as the provider asked', async () => {
    claudeSignIn(join(home, '.claude'))
    const usage = createUsage(deps())
    await usage.read()
    answers['api.anthropic.com'] = () => new Response('', { status: 429, headers: { 'retry-after': '900' } })
    clock += USAGE_TTL_MS
    const limited = (await usage.read()).accounts[0]
    expect(limited.problem).toBe('rate_limited')
    expect(limited.windows).toHaveLength(3)
    clock += USAGE_TTL_MS
    await usage.read(true)
    expect(calls).toHaveLength(2)
    clock += 900_000
    await usage.read()
    expect(calls).toHaveLength(3)
  })

  test('a rejected token reads as expired', async () => {
    claudeSignIn(join(home, '.claude'))
    answers['api.anthropic.com'] = () => new Response('', { status: 401 })
    expect((await createUsage(deps()).read()).accounts[0].problem).toBe('expired')
  })

  test('a second Claude account in ~/.claude-*, and the same account twice counts once', async () => {
    claudeSignIn(join(home, '.claude'), 'one')
    write(join(home, '.claude.json'), { oauthAccount: { accountUuid: 'u1', emailAddress: 'a@example.com' } })
    claudeSignIn(join(home, '.claude-work'), 'two')
    write(join(home, '.claude-work', '.claude.json'), { oauthAccount: { accountUuid: 'u2', emailAddress: 'b@corp' } })
    claudeSignIn(join(home, '.claude-copy'), 'three')
    write(join(home, '.claude-copy', '.claude.json'), {
      oauthAccount: { accountUuid: 'u1', emailAddress: 'a@example.com' },
    })
    const { accounts } = await createUsage(deps()).read()
    expect(accounts.map(a => a.label).sort()).toEqual(['a@example.com', 'b@corp'])
  })

  test('Codex: its workspace header, plan and both windows by their length', async () => {
    const token = jwt({
      exp: NOW / 1000 + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'ws1', chatgpt_user_id: 'user1', chatgpt_plan_type: 'plus' },
      'https://api.openai.com/profile': { email: 'c@example.com' },
    })
    write(join(home, '.codex', 'auth.json'), { tokens: { access_token: token } })
    answers['chatgpt.com'] = () =>
      Response.json({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 600 },
          secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: NOW / 1000 + 86400 },
        },
      })
    const { accounts } = await createUsage(deps()).read()
    expect(accounts).toEqual([
      {
        provider: 'codex',
        label: 'c@example.com',
        plan: 'pro',
        windows: [
          { kind: 'session', scope: null, usedPercent: 10, resetsAt: new Date(NOW + 600_000).toISOString() },
          { kind: 'week', scope: null, usedPercent: 55, resetsAt: new Date(NOW + 86_400_000).toISOString() },
        ],
      },
    ])
    expect(calls[0].headers['chatgpt-account-id']).toBe('ws1')
  })

  test('on macOS a sign-in kept in the keychain is read from there', async () => {
    const asked: string[] = []
    const keychain = async (service: string) => {
      asked.push(service)
      return service === 'Claude Code-credentials'
        ? JSON.stringify({ claudeAiOauth: { accessToken: 'kc', expiresAt: NOW + 1000 } })
        : null
    }
    const { accounts } = await createUsage(deps({ platform: 'darwin', keychain })).read()
    expect(accounts.map(a => a.provider)).toEqual(['claude'])
    expect(asked).toContain('Codex Auth')
    expect(calls[0].headers.authorization).toBe('Bearer kc')
  })
})

test('browsers asking at the same moment share one question to the provider', async () => {
  claudeSignIn(join(home, '.claude'))
  const usage = createUsage(deps())
  const reports = await Promise.all(Array.from({ length: 8 }, () => usage.read()))
  expect(calls).toHaveLength(1)
  expect(new Set(reports.map(r => r.accounts[0].windows.length))).toEqual(new Set([3]))
})
