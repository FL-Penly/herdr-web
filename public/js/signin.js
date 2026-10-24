import { checkToken } from './api.js'
import { isTokenShaped, storeToken, storedToken, tokenFromInput } from './auth.js'
import { $, esc } from './dom.js'
import { t } from './i18n/index.js'

let waiting = []

const visible = () => !$('#signin').hidden

function showError(key) {
  const el = $('#signin-error')
  el.hidden = !key
  el.textContent = key ? t(key) : ''
}

function renderHint() {
  const code = text => `<code>${esc(text)}</code>`
  $('#signin-hint').innerHTML = esc(t('signin.hint', { command: '\u0000', file: '\u0001' }))
    .replace('\u0000', code('bun run url'))
    .replace('\u0001', code('cat ~/.config/herdr-web/token'))
}

/** Resolves once a token the server accepts is stored; `error` is an i18n key. */
export function signIn({ error = '' } = {}) {
  const promise = new Promise(resolve => waiting.push(resolve))
  if (!visible()) {
    renderHint()
    $('#signin-token').value = ''
    $('#signin').hidden = false
    $('#app').inert = true
    setTimeout(() => $('#signin-token').focus(), 30)
  }
  showError(error)
  return promise
}

/**
 * Checks a token and, when the server accepts it, stores it and lets everything waiting on sign-in go on.
 * @param {string} token
 */
async function accept(token) {
  if (!token) return showError('signin.empty')
  if (!isTokenShaped(token)) return showError('signin.wrong')
  const button = $('#signin-submit')
  button.disabled = true
  button.textContent = t('signin.checking')
  const result = await checkToken(token)
  button.disabled = false
  button.textContent = t('signin.submit')
  if (result !== 'ok') return showError(result === 'unauthorized' ? 'signin.wrong' : 'signin.unreachable')
  storeToken(token)
  $('#signin').hidden = true
  $('#app').inert = false
  showError('')
  const resolvers = waiting
  waiting = []
  for (const resolve of resolvers) resolve(undefined)
}

function submit() {
  if ($('#signin-submit').disabled) return
  accept(tokenFromInput($('#signin-token').value))
}

/**
 * A login link opened in a tab that already shows the app only changes the fragment, which does not reload
 * the page: sign in with it here.
 * @param {string} token
 * @param {(error: string) => Promise<unknown>} suspend shows the sign-in view (closing sockets) when it is not up
 */
export async function signInWithLink(token, suspend) {
  if (!visible()) {
    if (token === storedToken()) return
    suspend('')
  }
  await accept(token)
}

export function initSignIn() {
  $('#signin-form').addEventListener('submit', e => {
    e.preventDefault()
    submit()
  })
  $('#signin-token').addEventListener('input', () => showError(''))
}
