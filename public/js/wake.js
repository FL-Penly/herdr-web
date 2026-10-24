// @ts-check
import { load, save } from './storage.js'

// Keep screen on (Settings): the screen stays awake while the app is in front, as when watching an agent work on a
// phone. The browser lets go of the lock whenever the page is hidden; it is taken again on return.
/** @type {any} */
let sentinel = null
let asking = false

export const canKeepAwake = () => 'wakeLock' in navigator && window.isSecureContext
export const keepAwakeOn = () => load('keepAwake', /** @type {boolean} */ (false)) === true

async function acquire() {
  if (!keepAwakeOn() || document.hidden || sentinel || asking || !canKeepAwake()) return
  asking = true
  try {
    const lock = await /** @type {any} */ (navigator).wakeLock.request('screen')
    // Turned off, or hidden, while the browser was granting it.
    if (!keepAwakeOn() || document.hidden) return void lock.release()
    sentinel = lock
    lock.addEventListener('release', () => {
      if (sentinel === lock) sentinel = null
    })
  } catch {
    // Refused (power saving, no user gesture yet): tried again the next time the page comes back.
  } finally {
    asking = false
  }
}

/** @param {boolean} on */
export function setKeepAwake(on) {
  save('keepAwake', on)
  if (on) void acquire()
  else void sentinel?.release()
}

export function initKeepAwake() {
  document.addEventListener('visibilitychange', () => void acquire())
  void acquire()
}
