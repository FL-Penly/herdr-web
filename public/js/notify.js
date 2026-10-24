import { $, esc, icon, isNarrow } from './dom.js'
import { t } from './i18n/index.js'
import { inboxReasonLabel, inboxSummary } from './labels.js'
import { state } from './state.js'
import { load, save } from './storage.js'

const TOAST_MS = { need: 12_000, error: 7000, default: 2600 }
// A phone shows one compact banner under the top bar, so the tabs, the title and the needs button stay
// reachable; the needs badge keeps counting what a replaced banner said.
const maxToasts = () => (isNarrow() ? 1 : 4)
const DEFER_POLL_MS = 400
const deferred = []
let deferTimer = null

// While a drawer, a sheet or a dialog is open on a phone, a banner would land on top of what is being done.
const layerOpen = () =>
  !!document.querySelector('#app.is-drawer-open, .popover.is-sheet:not([hidden]), dialog[open], #review:not([hidden])')

// Below whichever top bar is on screen; the banner covers thread content, never the controls.
function placeBelowBar(box) {
  const bars = [...document.querySelectorAll('.view:not([hidden]) > .bar')]
  const bottom = Math.max(0, ...bars.map(bar => bar.getBoundingClientRect().bottom))
  box.style.setProperty('--toast-top', `${Math.round(bottom)}px`)
}

function flushDeferred() {
  deferTimer = null
  if (layerOpen()) {
    deferTimer = setTimeout(flushDeferred, DEFER_POLL_MS)
    return
  }
  // Only the newest of what piled up: older ones are stale, and the needs badge lists them anyway.
  const last = deferred.at(-1)
  deferred.length = 0
  if (last) toast(...last)
}

/**
 * @param {string} title
 * @param {string} [body]
 * @param {'' | 'need' | 'done' | 'error'} [kind]
 * @param {(() => void) | null} [onClick]
 */
export function toast(title, body = '', kind = '', onClick = null) {
  const box = $('#toasts')
  if (isNarrow()) {
    if (layerOpen() && kind !== 'error') {
      deferred.push([title, body, kind, onClick])
      deferTimer ??= setTimeout(flushDeferred, DEFER_POLL_MS)
      return
    }
    placeBelowBar(box)
  }
  const el = document.createElement('div')
  el.className = `toast${kind ? ` toast-${kind}` : ''}`
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  const text = `<span class="toast-title">${esc(title)}</span>${body ? `<span class="toast-body">${esc(body)}</span>` : ''}`
  const main = onClick
    ? `<button type="button" class="toast-main">${text}</button>`
    : `<div class="toast-main">${text}</div>`
  el.innerHTML = `${main}<button type="button" class="toast-close" aria-label="${esc(t('toast.dismiss'))}" title="${esc(t('toast.dismiss'))}">${icon('x', 'xs')}</button>`
  el.querySelector('.toast-main')?.addEventListener('click', () => {
    onClick?.()
    el.remove()
  })
  el.querySelector('.toast-close')?.addEventListener('click', () => el.remove())
  box.prepend(el)
  setTimeout(() => el.remove(), TOAST_MS[kind] ?? TOAST_MS.default)
  while (box.children.length > maxToasts()) box.lastElementChild?.remove()
}

let audio = null

function beep(reason) {
  if (!state.sound) return
  try {
    audio ??= new AudioContext()
    const notes = reason === 'done' ? [660, 990] : [880, 660, 880]
    notes.forEach((frequency, i) => {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      const t0 = audio.currentTime + i * 0.11
      osc.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(0.09, t0 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1)
      osc.connect(gain).connect(audio.destination)
      osc.start(t0)
      osc.stop(t0 + 0.11)
    })
  } catch {}
}

// Browsers only offer notifications to secure contexts: HTTPS, or http://localhost (an SSH tunnel).
export const canNotify = () => window.isSecureContext && 'Notification' in window
const granted = () => canNotify() && Notification.permission === 'granted'

// Before this setting existed, a granted permission meant notifications were on.
let notifyOn = load('notify', null) ?? granted()

export const notificationsOn = () => notifyOn && granted()

// Android Chrome has no `new Notification()`; a service worker shows them there (and in a home-screen app).
async function registration() {
  if (!('serviceWorker' in navigator)) return null
  try {
    return (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js'))
  } catch {
    return null
  }
}

async function showNotification(title, body, pane, open) {
  const reg = await registration()
  if (reg) return reg.showNotification(title, { body, tag: pane, data: { pane } })
  const n = new Notification(title, { body, tag: pane })
  n.onclick = () => {
    window.focus()
    open(pane)
  }
}

/**
 * @param {import('../../src/protocol.ts').AgentView} agent
 * @param {(pane: string) => void} open
 * @param {{ toast?: boolean }} [o]
 */
export function notifyAgent(agent, open, { toast: showToast = true } = {}) {
  const inbox = agent.inbox
  if (!inbox) return
  const title = `${agent.title || agent.workspaceLabel} · ${inboxReasonLabel(inbox)}`
  const body = inboxSummary(inbox)
  if (showToast) toast(title, body, inbox.reason === 'done' ? 'done' : 'need', () => open(agent.pane))
  beep(inbox.reason)
  if (notificationsOn() && (document.hidden || !document.hasFocus())) {
    showNotification(title, body, agent.pane, open).catch(() => {})
  }
}

/** Opt in (asking for permission) or out; resolves to whether notifications are now on. */
export async function setNotifications(on) {
  if (on && !canNotify()) {
    toast(t('notify.unavailable'), t('notify.unavailableBody'), 'error')
    return false
  }
  if (on && Notification.permission !== 'granted') {
    if ((await Notification.requestPermission()) !== 'granted') {
      toast(t('notify.denied'), t('notify.deniedBody'), 'error')
      return false
    }
  }
  notifyOn = on
  save('notify', on)
  if (on) {
    await registration()
    toast(t('notify.enabled'), t('notify.enabledBody'))
  }
  return on
}

export const notificationsLabel = () => (notificationsOn() ? t('settings.notifyOn') : t('settings.notifyOff'))

/** @param {(pane: string) => void} open */
export function initNotifications(open) {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'open' && typeof e.data.pane === 'string') open(e.data.pane)
  })
  if (notificationsOn()) registration()
}

export function setSound(on) {
  state.sound = on
  save('sound', on)
  if (on) beep('done')
}

export const soundLabel = () => (state.sound ? t('settings.soundOn') : t('settings.soundOff'))
