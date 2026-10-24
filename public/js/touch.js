// @ts-check
// Pure helpers for phones and tablets: layout breakpoints, the on-screen keyboard, gestures, terminal keys.

/**
 * The phone layout: narrow screens, and phones held sideways (wider than the breakpoint but very short).
 * Keep in sync with the `@media` blocks in public/css.
 */
export const MOBILE_QUERY = '(max-width: 820px), (max-height: 520px) and (pointer: coarse)'
/** Fingers, no hover: tap targets grow and Enter in the composer inserts a newline. */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)'

/** Below this many pixels a shrunken viewport is browser chrome (URL bar), not a keyboard. */
export const KEYBOARD_MIN_PX = 120
export const LONG_PRESS_MS = 480
export const LONG_PRESS_SLOP_PX = 10
/** A swipe that opens the drawer starts in this share of the screen's width. */
export const DRAWER_SWIPE_ZONE = 0.4

/**
 * How much of the layout viewport the on-screen keyboard covers. iOS keeps the layout viewport and shrinks
 * (and pans) the visual one; Android with `interactive-widget=resizes-content` shrinks both, so this is 0
 * there.
 * @param {number} layoutHeight window.innerHeight
 * @param {{ height: number; offsetTop: number }} visual window.visualViewport
 */
export function keyboardInset(layoutHeight, visual) {
  return Math.max(0, Math.round(layoutHeight - visual.height - visual.offsetTop))
}

/**
 * Whether the keyboard is up: a text field has focus and the visible area lost at least KEYBOARD_MIN_PX,
 * either to the visual viewport (iOS) or against the tallest layout seen at this width (Android).
 * @param {{ inset: number; layoutHeight: number; tallest: number; editing: boolean }} s
 */
export function isKeyboardOpen({ inset, layoutHeight, tallest, editing }) {
  return editing && (inset >= KEYBOARD_MIN_PX || tallest - layoutHeight >= KEYBOARD_MIN_PX)
}

/**
 * What a finished horizontal swipe means for the drawer: open it when it moved right from the left part of
 * the screen (`edge` px; the very edge belongs to the browser's and the OS's back gesture), close it when
 * the drawer is open and the swipe went left. Mostly-vertical moves are scrolls.
 * @param {{ x: number; y: number }} start
 * @param {{ x: number; y: number }} end
 * @param {{ open: boolean; edge: number; min?: number }} o
 * @returns {'open' | 'close' | null}
 */
export function swipeIntent(start, end, { open, edge, min = 56 }) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (Math.abs(dx) < min || Math.abs(dy) > Math.abs(dx) * 0.6) return null
  if (!open && dx > 0 && start.x <= edge) return 'open'
  if (open && dx < 0) return 'close'
  return null
}

/**
 * Turns a finger or wheel movement into whole terminal lines, keeping the remainder for the next event.
 * Positive `delta` scrolls down (towards newer output).
 * @param {number} carry pixels left over from earlier events
 * @param {number} delta
 * @param {number} pxPerLine
 */
export function scrollLines(carry, delta, pxPerLine) {
  const total = carry + delta
  const lines = Math.trunc(total / pxPerLine)
  return { lines, carry: total - lines * pxPerLine }
}

/** `c` → ETX; null when Ctrl+key has no control character. @param {string} key */
export function ctrlSequence(key) {
  if (key.length !== 1) return null
  if (key === ' ' || key === '@') return '\x00'
  if (key === '?') return '\x7f'
  const code = key.toUpperCase().charCodeAt(0)
  // A–Z and [ \ ] ^ _ map to 1–31.
  return code >= 65 && code <= 95 ? String.fromCharCode(code - 64) : null
}

// Keys whose xterm form takes a modifier parameter: ESC [ 1 ; <m> <final>.
/** @type {Record<string, string>} */
const CSI_KEYS = { '\x1b[A': 'A', '\x1b[B': 'B', '\x1b[C': 'C', '\x1b[D': 'D', '\x1b[H': 'H', '\x1b[F': 'F' }

/**
 * What a key sends with the modifiers held on the phone's key bar, as xterm encodes it: arrows carry a modifier
 * parameter, Shift+Tab is back-tab, Ctrl makes a control character, Alt puts ESC in front. Anything longer than
 * one key (pasted or dictated text) goes as it is.
 * @param {string} data
 * @param {{ ctrl?: boolean; alt?: boolean; shift?: boolean }} mods
 */
export function withModifiers(data, { ctrl = false, alt = false, shift = false }) {
  if (!ctrl && !alt && !shift) return data
  const final = CSI_KEYS[data]
  if (final) return `\x1b[1;${1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)}${final}`
  if (data === '\t' && shift) return alt ? '\x1b\x1b[Z' : '\x1b[Z'
  if ([...data].length !== 1) return data
  let key = shift ? data.toUpperCase() : data
  if (ctrl) key = ctrlSequence(key) ?? key
  return alt ? `\x1b${key}` : key
}

export const TERMINAL_FONT = { min: 8, max: 18 }

/** @param {number} size */
export const clampTerminalFont = size =>
  Math.min(TERMINAL_FONT.max, Math.max(TERMINAL_FONT.min, Math.round(Number(size) || 0)))

/**
 * The next terminal font size from the one on screen (which fitting may have made fractional).
 * @param {number} shown
 * @param {1 | -1} direction
 */
export const stepTerminalFont = (shown, direction) =>
  clampTerminalFont((direction > 0 ? Math.floor(shown) : Math.ceil(shown)) + direction)
