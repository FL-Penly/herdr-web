import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  TOKEN_KEY,
  authHeaders,
  clearToken,
  isSpent,
  isTokenShaped,
  linkUsable,
  markSpent,
  storeToken,
  storedToken,
  takeLoginFromAddress,
  takeTokenFromUrl,
  tokenChange,
  tokenFromInput,
  wsProtocols,
} from '../../public/js/auth.js'
import { initBackButton } from '../../public/js/gestures.js'
import { FakeHistory } from './fake-history.ts'
import { installMemoryStorage } from './memory-storage.ts'

const TOKEN = 'Ab3_def-GHIjkl0123456789xyzXYZ_-'

describe('the sign-in field', () => {
  test('takes a bare token, trimmed', () => {
    expect(tokenFromInput(`  ${TOKEN}\n`)).toBe(TOKEN)
    expect(tokenFromInput('   ')).toBe('')
  })

  test('takes a whole login link, with the token in the fragment or the query', () => {
    expect(tokenFromInput(`http://127.0.0.1:12500/#t=${TOKEN}`)).toBe(TOKEN)
    expect(tokenFromInput(`https://box.tail1234.ts.net/?t=${TOKEN}`)).toBe(TOKEN)
    expect(tokenFromInput(`http://localhost:12500/?pane=w1:p2&t=${TOKEN}`)).toBe(TOKEN)
    expect(tokenFromInput(`/#t=${TOKEN}`)).toBe(TOKEN)
    expect(tokenFromInput(`t=${TOKEN}`)).toBe(TOKEN)
  })

  test('only token characters can ride in a WebSocket subprotocol', () => {
    expect(isTokenShaped(TOKEN)).toBe(true)
    expect(isTokenShaped('a.b~c-d_e0123456789')).toBe(true)
    expect(isTokenShaped('has space')).toBe(false)
    expect(isTokenShaped('a,b')).toBe(false)
    expect(isTokenShaped('')).toBe(false)
  })
})

describe('a login URL', () => {
  test('gives up its token, which is removed from the address', () => {
    expect(takeTokenFromUrl(`http://h:1/#t=${TOKEN}`)).toEqual({ token: TOKEN, url: '/' })
    expect(takeTokenFromUrl(`http://h:1/?t=${TOKEN}`)).toEqual({ token: TOKEN, url: '/' })
  })

  test('keeps everything else in the address', () => {
    expect(takeTokenFromUrl(`http://h:1/?pane=w1%3Ap2&t=${TOKEN}&lang=zh-CN`)).toEqual({
      token: TOKEN,
      url: '/?pane=w1%3Ap2&lang=zh-CN',
    })
  })

  test('without a token is left alone', () => {
    expect(takeTokenFromUrl('http://h:1/?pane=w1%3Ap2#x')).toEqual({ token: null, url: '/?pane=w1%3Ap2#x' })
  })
})

describe('credentials', () => {
  beforeEach(() => installMemoryStorage())

  test('the token is kept in origin-scoped storage under herdr-web:token', () => {
    const data = installMemoryStorage()
    expect(storedToken()).toBe('')
    storeToken(TOKEN)
    expect(data.get(TOKEN_KEY)).toBe(TOKEN)
    expect(storedToken()).toBe(TOKEN)
    clearToken()
    expect(data.has(TOKEN_KEY)).toBe(false)
  })

  test('API requests carry a bearer header, none when auth is off', () => {
    expect(authHeaders(TOKEN)).toEqual({ authorization: `Bearer ${TOKEN}` })
    expect(authHeaders('')).toEqual({})
  })

  test('sockets offer herdr-web first, so the server can pick it without echoing the token', () => {
    expect(wsProtocols(TOKEN)).toEqual(['herdr-web', `bearer.${TOKEN}`])
    expect(wsProtocols('')).toEqual(['herdr-web'])
  })
})

describe('a login link and the Back button', () => {
  const globals = ['history', 'window', 'location'] as const
  const saved = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  let session: Map<string, string>
  beforeEach(() => {
    installMemoryStorage()
    session = installMemoryStorage('sessionStorage')
  })
  afterEach(() => {
    globals.forEach((name, i) => {
      const descriptor = saved[i]
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as Record<string, unknown>)[name]
    })
  })

  // What boot does on a phone: take the token, arm Back, sign in; the hashchange listener checks linkUsable.
  function openOnPhone(href: string, closeTop = () => false) {
    const fake = new FakeHistory(href)
    fake.install()
    const token = takeLoginFromAddress()
    initBackButton(closeTop)
    if (token) storeToken(token)
    return { fake, token }
  }

  test('no history entry keeps the token once the app has armed Back', () => {
    const { fake, token } = openOnPhone(`http://h:1/?pane=w1%3Ap2#t=${TOKEN}`)
    expect(token).toBe(TOKEN)
    expect(fake.entries.map(e => e.url)).toEqual(['http://h:1/?pane=w1%3Ap2', 'http://h:1/?pane=w1%3Ap2'])
    expect(fake.entries.map(e => e.state)).toEqual([{ herdr: 'base' }, { herdr: 'armed' }])
  })

  test('arming Back never copies a token-bearing address, even when nothing took it first', () => {
    const fake = new FakeHistory(`http://h:1/#t=${TOKEN}`)
    fake.install()
    initBackButton(() => false)
    expect(fake.entries.some(e => e.url.includes(TOKEN))).toBe(false)
  })

  test('the token is scrubbed without losing the entry state', () => {
    const fake = new FakeHistory(`http://h:1/#t=${TOKEN}`)
    fake.install()
    fake.replaceState({ herdr: 'armed' }, '')
    expect(takeLoginFromAddress()).toBe(TOKEN)
    expect(fake.entries).toEqual([{ url: 'http://h:1/', state: { herdr: 'armed' } }])
    expect(takeLoginFromAddress()).toBeNull()
  })

  test('sign in by link, open the drawer, sign out, Back: still signed out, no token in history', () => {
    let drawerOpen = true
    const { fake } = openOnPhone(`http://h:1/#t=${TOKEN}`, () => {
      const was = drawerOpen
      drawerOpen = false
      return was
    })
    const signedInBy: string[] = []
    fake.window.addEventListener('hashchange', () => {
      const link = takeTokenFromUrl(fake.href)
      if (link.token !== null && linkUsable(link.token, true)) signedInBy.push(link.token)
    })
    // Sign out (settings in the drawer).
    markSpent(storedToken())
    clearToken()
    fake.back()
    expect(drawerOpen).toBe(false)
    expect(signedInBy).toEqual([])
    expect(storedToken()).toBe('')
    expect(fake.entries.some(e => e.url.includes('t='))).toBe(false)
    expect([...session.values()].join()).not.toContain(TOKEN)
  })

  test('a link reached by Back never signs in; one opened anew does', () => {
    expect(linkUsable(TOKEN, true)).toBe(false)
    expect(linkUsable(TOKEN, false)).toBe(true)
    expect(linkUsable(TOKEN, null)).toBe(true)
    markSpent(TOKEN)
    expect(isSpent(TOKEN)).toBe(true)
    expect(isSpent('other-token')).toBe(false)
    // Without the Navigation API there is no telling Back from a paste: a token signed out of is refused.
    expect(linkUsable(TOKEN, null)).toBe(false)
    expect(linkUsable(TOKEN, false)).toBe(true)
  })

  test('spent fingerprints stay few', () => {
    for (let i = 0; i < 20; i++) markSpent(`token-${i}`)
    expect(JSON.parse(session.get('herdr-web:spent-links') ?? '[]')).toHaveLength(8)
    expect(isSpent('token-19')).toBe(true)
    expect(isSpent('token-0')).toBe(false)
  })
})

describe('another tab', () => {
  test('removing the token signs this tab out', () => {
    expect(tokenChange({ key: TOKEN_KEY, newValue: null }, TOKEN)).toEqual({ kind: 'signedOut' })
    expect(tokenChange({ key: null, newValue: null }, TOKEN)).toEqual({ kind: 'signedOut' })
  })

  test('a different token makes this tab reconnect with it', () => {
    expect(tokenChange({ key: TOKEN_KEY, newValue: 'new-token' }, TOKEN)).toEqual({
      kind: 'replaced',
      token: 'new-token',
    })
    expect(tokenChange({ key: TOKEN_KEY, newValue: TOKEN }, '')).toEqual({ kind: 'replaced', token: TOKEN })
  })

  test('other keys, or the token this tab already holds, change nothing', () => {
    expect(tokenChange({ key: 'herdr-web:drafts', newValue: null }, TOKEN)).toBeNull()
    expect(tokenChange({ key: TOKEN_KEY, newValue: TOKEN }, TOKEN)).toBeNull()
    expect(tokenChange({ key: null, newValue: null }, '')).toBeNull()
  })
})
