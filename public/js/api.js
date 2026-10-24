// @ts-check
import { authHeaders, signalUnauthorized, storedToken, wsProtocols } from './auth.js'
import { hasKey, t } from './i18n/index.js'
import { toast } from './notify.js'

/** @typedef {import('../../src/protocol.ts').Action} Action */
/** @typedef {import('../../src/protocol.ts').StatePayload} StatePayload */

/** An error the server answered with; `code` is its machine-readable reason (`stale_dialog`, `unauthorized`…). */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ draft?: string }} [data] what the server sent with the error (`terminal_draft`: the draft)
   */
  constructor(message, code, data = {}) {
    super(message)
    this.code = code
    this.data = data
  }
}

/** @param {{ error?: string; code?: string; draft?: string }} body */
function errorFrom(body, fallback = '') {
  const code = body.code ?? 'unknown'
  const key = `error.${code}`
  const data = typeof body.draft === 'string' ? { draft: body.draft } : {}
  return new ApiError(hasKey(key) ? t(key) : body.error || fallback || code, code, data)
}

/** @param {unknown} err */
export const isUnauthorized = err => err instanceof ApiError && err.code === 'unauthorized'

/** @param {Response} res */
async function parse(res) {
  if (res.status === 401) {
    signalUnauthorized()
    throw errorFrom({ code: 'unauthorized' })
  }
  const body = await res.json().catch(() => ({ ok: false, error: res.statusText, code: `http_${res.status}` }))
  if (body.ok === false) throw errorFrom(body, res.statusText)
  return body
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
const authedFetch = (path, init = {}) => {
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(authHeaders(storedToken()))) headers.set(name, value)
  return fetch(path, { ...init, headers })
}

/**
 * Whether the server takes this token ('' when auth is off), without signalling a sign-out.
 * @param {string} token
 * @returns {Promise<'ok' | 'unauthorized' | 'unreachable'>}
 */
export async function checkToken(token) {
  try {
    const res = await fetch('/api/session', { headers: authHeaders(token), cache: 'no-store' })
    if (res.status === 401) return 'unauthorized'
    return res.ok ? 'ok' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

/**
 * A WebSocket that closed before it opened was refused or could not connect: ask over HTTP which.
 * @returns {Promise<boolean>} whether it was the token
 */
export async function socketRefused() {
  if ((await checkToken(storedToken())) !== 'unauthorized') return false
  signalUnauthorized()
  return true
}

/**
 * @param {string} path
 * @param {Record<string, string | number>} [params]
 */
function apiUrl(path, params = {}) {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  const qs = query.toString()
  return qs ? `${path}?${qs}` : path
}

/**
 * @param {string} path
 * @param {Record<string, string | number>} [params]
 * @param {AbortSignal} [signal]
 */
export async function getJson(path, params, signal) {
  return parse(await authedFetch(apiUrl(path, params), { signal }))
}

/**
 * A file an agent wrote about, resolved against the pane's folder: its bytes, type and full path.
 * @param {string} pane
 * @param {string} path
 * @returns {Promise<{ blob: Blob; type: string; path: string }>}
 */
export async function fetchFile(pane, path) {
  const res = await authedFetch(apiUrl('/api/file', { pane, path }))
  if (!res.ok) await parse(res)
  const blob = await res.blob()
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
  return { blob, type, path: decodeURIComponent(res.headers.get('x-file-path') ?? path) }
}

/** @param {Action} action */
export async function sendAction(action) {
  const res = await authedFetch('/api/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  })
  return parse(res)
}

/**
 * Runs an action; on failure shows a toast and resolves to null.
 * @param {Action} action
 * @param {string} [okMessage]
 */
export async function postAction(action, okMessage) {
  try {
    const body = await sendAction(action)
    if (okMessage) toast(okMessage)
    return body
  } catch (err) {
    if (!isUnauthorized(err)) toast(t('toast.actionFailed'), /** @type {Error} */ (err).message, 'error')
    return null
  }
}

/**
 * @param {File} file
 * @param {string} name
 * @returns {Promise<string>} the server-side path
 */
export async function uploadFile(file, name) {
  const res = await authedFetch(apiUrl('/api/upload', { name }), { method: 'POST', body: file })
  const body = await parse(res)
  return body.path
}

/**
 * Uploads like `uploadFile`, reporting progress (0–1); `abort()` cancels it (the promise then rejects with
 * code `aborted`). fetch() cannot report upload progress, XMLHttpRequest can.
 * @param {File} file
 * @param {string} name
 * @param {(fraction: number) => void} onProgress
 * @returns {{ done: Promise<string>; abort: () => void }}
 */
export function uploadWithProgress(file, name, onProgress) {
  const xhr = new XMLHttpRequest()
  const done = new Promise((resolve, reject) => {
    xhr.open('POST', apiUrl('/api/upload', { name }))
    for (const [header, value] of Object.entries(authHeaders(storedToken()))) xhr.setRequestHeader(header, value)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status === 401) {
        signalUnauthorized()
        return reject(errorFrom({ code: 'unauthorized' }))
      }
      let body
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        body = { ok: false, error: xhr.statusText, code: `http_${xhr.status}` }
      }
      if (body.ok === false) reject(errorFrom(body, xhr.statusText))
      else resolve(body.path)
    }
    xhr.onerror = () => reject(new ApiError(t('toast.uploadNetwork'), 'network'))
    xhr.onabort = () => reject(new ApiError('aborted', 'aborted'))
    xhr.send(file)
  })
  return { done, abort: () => xhr.abort() }
}

/**
 * @param {string} path
 * @param {Record<string, string | number>} [params]
 */
export function wsUrl(path, params) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${apiUrl(path, params)}`
}

/**
 * A WebSocket that authenticates with the stored token. A token the subprotocol syntax cannot carry was never
 * valid; it is treated like a refused one (null).
 * @param {string} path
 * @param {Record<string, string | number>} [params]
 */
export function openSocket(path, params) {
  try {
    return new WebSocket(wsUrl(path, params), wsProtocols(storedToken()))
  } catch {
    signalUnauthorized()
    return null
  }
}

/**
 * Keeps /ws/state connected, reconnecting with exponential backoff (0.5 s → 8 s), until stopped or the
 * token is refused.
 * @param {(payload: StatePayload) => void} onPayload
 * @param {(connected: boolean) => void} onConnection
 */
export function connectStateSocket(onPayload, onConnection) {
  let retry = 500
  /** @type {WebSocket | null} */
  let current = null
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  let stopped = false
  const connect = () => {
    timer = undefined
    const ws = openSocket('/ws/state')
    if (!ws) return
    current = ws
    let opened = false
    ws.onopen = () => {
      opened = true
      retry = 500
      onConnection(true)
    }
    ws.onclose = async () => {
      if (current !== ws) return
      current = null
      onConnection(false)
      if (stopped || (!opened && (await socketRefused())) || stopped || current || timer) return
      timer = setTimeout(connect, retry)
      retry = Math.min(retry * 2, 8000)
    }
    ws.onmessage = event => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message?.type === 'state') onPayload(message)
    }
  }
  return {
    start() {
      stopped = false
      retry = 500
      if (!current && !timer) connect()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      timer = undefined
      const ws = current
      current = null
      ws?.close()
      onConnection(false)
    },
  }
}
