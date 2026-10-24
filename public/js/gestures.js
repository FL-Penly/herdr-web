import { takeTokenFromUrl } from './auth.js'
import { DRAWER_SWIPE_ZONE, LONG_PRESS_MS, LONG_PRESS_SLOP_PX, swipeIntent } from './touch.js'

// Areas that scroll sideways (or take every touch) keep their own horizontal swipes.
const OWN_SWIPES = 'pre, table, .tab-list, .mobile-keys, .term, .review-diff, input, textarea'

/**
 * Long-press on touch screens opens what right-click opens. Android also fires `contextmenu` on a long
 * press; then that handler runs and the timer here is dropped, so the menu opens once.
 * @param {HTMLElement} root
 * @param {string} selector
 * @param {(el: HTMLElement, point: { x: number; y: number }) => void} handler
 */
export function onLongPress(root, selector, handler) {
  let timer = null
  let start = null
  let fired = false
  const cancel = () => {
    clearTimeout(timer)
    timer = null
  }
  root.addEventListener(
    'touchstart',
    e => {
      const el = e.target.closest(selector)
      cancel()
      fired = false
      if (!el || e.touches.length > 1) return
      const touch = e.touches[0]
      start = { x: touch.clientX, y: touch.clientY }
      timer = setTimeout(() => {
        timer = null
        fired = true
        navigator.vibrate?.(8)
        handler(el, start)
      }, LONG_PRESS_MS)
    },
    { passive: true },
  )
  root.addEventListener(
    'touchmove',
    e => {
      const touch = e.touches[0]
      if (timer && start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel()
    },
    { passive: true },
  )
  root.addEventListener('touchend', e => {
    cancel()
    if (fired && e.cancelable) e.preventDefault()
  })
  root.addEventListener('touchcancel', cancel)
  root.addEventListener(
    'contextmenu',
    e => {
      if (!timer && !fired) return
      if (fired) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      cancel()
      fired = true
    },
    true,
  )
}

export function initDrawerSwipe({ drawer, isEnabled, isOpen, open, close }) {
  const zone = () => window.innerWidth * DRAWER_SWIPE_ZONE
  let start = null
  let dragging = false
  let wasOpen = false
  const reset = () => {
    drawer.style.transform = ''
    drawer.style.transition = ''
    dragging = false
    start = null
  }
  document.addEventListener(
    'touchstart',
    e => {
      // A re-render can detach the node a drag started on, and its touchend never reaches the document.
      if (start) reset()
      if (!isEnabled() || e.touches.length > 1) return
      const touch = e.touches[0]
      wasOpen = isOpen()
      if (!wasOpen && (touch.clientX > zone() || e.target.closest?.(OWN_SWIPES))) return
      start = { x: touch.clientX, y: touch.clientY }
    },
    { passive: true },
  )
  document.addEventListener(
    'touchmove',
    e => {
      if (!start) return
      const touch = e.touches[0]
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (!dragging) {
        if (Math.abs(dx) < 12) return
        if (Math.abs(dy) > Math.abs(dx) || (wasOpen ? dx > 0 : dx < 0)) {
          start = null
          return
        }
        dragging = true
        drawer.style.transition = 'none'
      }
      const width = drawer.offsetWidth
      const offset = wasOpen ? Math.min(0, dx) : Math.min(0, dx - width)
      drawer.style.transform = `translateX(${offset}px)`
    },
    { passive: true },
  )
  const finish = e => {
    if (!start) return
    const touch = e.changedTouches[0]
    const intent = dragging
      ? swipeIntent(start, { x: touch.clientX, y: touch.clientY }, { open: wasOpen, edge: zone() })
      : null
    reset()
    if (intent === 'open') open()
    else if (intent === 'close') close()
  }
  document.addEventListener('touchend', finish, { passive: true })
  document.addEventListener('touchcancel', reset, { passive: true })
}

/**
 * The phone's Back (Android's button or gesture, iOS's edge swipe in a home-screen app) closes the topmost
 * overlay instead of leaving the app. One extra history entry is kept armed while the app runs; with
 * nothing open, Back goes on to the page before.
 * @param {() => boolean} closeTop closes the topmost overlay, false when none was open
 */
export function initBackButton(closeTop) {
  const armed = { herdr: 'armed' }
  if (history.state?.herdr !== 'armed') {
    // The caller takes a login token out of the address first; never copy one into a second entry regardless.
    const url = takeTokenFromUrl(location.href).url
    history.replaceState({ herdr: 'base' }, '', url)
    history.pushState(armed, '', url)
  }
  window.addEventListener('popstate', e => {
    if (e.state?.herdr !== 'base') return
    if (closeTop()) history.pushState(armed, '')
    else history.back()
  })
}
