// @ts-check

// The token lives in localStorage, which is scoped to scheme + host + port: unlike a cookie, a service on
// another port of the same host never sees it.
export const TOKEN_KEY = 'herdr-web:token'
export const WS_PROTOCOL = 'herdr-web'
const BEARER_PROTOCOL = 'bearer.'
// The token travels as a WebSocket subprotocol, which only allows HTTP token characters.
const TOKEN_RE = /^[\w.~-]+$/

/** @returns {string} the stored token, or '' */
export function storedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

/** @param {string} token */
export function storeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

export const clearToken = () => storeToken('')

/** @param {string} token */
export const isTokenShaped = token => TOKEN_RE.test(token)

/** @param {URL} url */
function linkToken(url) {
  const fromHash = new URLSearchParams(url.hash.replace(/^#/, '')).get('t')
  return fromHash ?? url.searchParams.get('t')
}

/**
 * What the sign-in field holds: a bare token, or a whole login link pasted from `bun run url`.
 * @param {string} input
 * @returns {string} the token, or '' when there is none
 */
export function tokenFromInput(input) {
  const text = input.trim()
  if (!text) return ''
  if (/[?#&]t=/.test(text) || text.startsWith('t=')) {
    try {
      const token = linkToken(new URL(text.startsWith('t=') ? `#${text}` : text, 'http://link.invalid/'))
      if (token != null) return token.trim()
    } catch {}
  }
  return text
}

/**
 * Takes a login token out of the address so it is not left in the history or a bookmark.
 * @param {string} href
 * @returns {{ token: string | null; url: string }} `url` is the path, query and fragment to show instead
 */
export function takeTokenFromUrl(href) {
  const url = new URL(href)
  const token = linkToken(url)
  if (token == null) return { token: null, url: url.pathname + url.search + url.hash }
  url.searchParams.delete('t')
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  hash.delete('t')
  url.hash = hash.toString()
  return { token: token.trim(), url: url.pathname + url.search + url.hash }
}

/**
 * Takes the login token out of the current address before anything copies that address into another history
 * entry (the phone's Back button arms one), keeping the entry's state.
 * @param {{ location: { href: string }; history: { state: unknown; replaceState(state: unknown, unused: string, url: string): void } }} [page]
 * @returns {string | null}
 */
export function takeLoginFromAddress(page = /** @type {any} */ (globalThis)) {
  const link = takeTokenFromUrl(page.location.href)
  if (link.token !== null) page.history.replaceState(page.history.state, '', link.url)
  return link.token
}

// Tokens this tab signed out of, as fingerprints: a login link reached again by Back must not undo a sign-out,
// and the token itself is not kept around to tell.
const SPENT_KEY = 'herdr-web:spent-links'
const SPENT_MAX = 8

/** @param {string} token FNV-1a, enough to recognise a token without storing it */
function fingerprint(token) {
  let hash = 0x811c9dc5
  for (let i = 0; i < token.length; i++) hash = Math.imul(hash ^ token.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(36)
}

/** @returns {string[]} */
function spentList() {
  try {
    const list = JSON.parse(sessionStorage.getItem(SPENT_KEY) ?? '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** @param {string} token */
export function markSpent(token) {
  if (!token) return
  const print = fingerprint(token)
  const list = [print, ...spentList().filter(p => p !== print)].slice(0, SPENT_MAX)
  try {
    sessionStorage.setItem(SPENT_KEY, JSON.stringify(list))
  } catch {}
}

/** @param {string} token */
export const isSpent = token => spentList().includes(fingerprint(token))

/**
 * Whether a login link in the address may sign this tab in. A link reached by history traversal never does;
 * when the browser cannot say how the address was reached (`traversal` null), a token this tab signed out of
 * is refused, so the link has to be pasted into the sign-in field instead.
 * @param {string} token
 * @param {boolean | null} traversal
 */
export const linkUsable = (token, traversal) => traversal === false || (traversal === null && !isSpent(token))

/**
 * What a `storage` event from another tab means for this one: the token was removed (sign out) or replaced.
 * @param {{ key: string | null; newValue: string | null }} event
 * @param {string} current the token this tab holds now
 * @returns {{ kind: 'signedOut' } | { kind: 'replaced'; token: string } | null}
 */
export function tokenChange(event, current) {
  // `localStorage.clear()` elsewhere reports a null key.
  if (event.key !== null && event.key !== TOKEN_KEY) return null
  const next = event.key === null ? '' : (event.newValue ?? '')
  if (next === current) return null
  return next ? { kind: 'replaced', token: next } : { kind: 'signedOut' }
}

/**
 * @param {string} token
 * @returns {Record<string, string>}
 */
export const authHeaders = token => (token ? { authorization: `Bearer ${token}` } : {})

/** @param {string} token */
export const wsProtocols = token => (token ? [WS_PROTOCOL, BEARER_PROTOCOL + token] : [WS_PROTOCOL])

/** @type {Set<() => void>} */
const listeners = new Set()

/** @param {() => void} listener */
export function onUnauthorized(listener) {
  listeners.add(listener)
}

export function signalUnauthorized() {
  for (const listener of listeners) listener()
}
