import { isKeyboardOpen, keyboardInset } from './touch.js'

const listeners = new Set()
const tallest = new Map()
let keyboardOpen = false

export const isKeyboardUp = () => keyboardOpen

export function onKeyboardChange(listener) {
  listeners.add(listener)
}

const isTextField = el =>
  el instanceof HTMLElement &&
  (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'file'))

// The app is sized to the visual viewport, so iOS (which keeps the layout viewport under its keyboard) has
// nothing left to pan, and the composer and sheets sit right above the keyboard.
function update() {
  const root = document.documentElement
  const vv = window.visualViewport
  if (vv && vv.scale > 1.01) return
  const layoutHeight = window.innerHeight
  const width = window.innerWidth
  tallest.set(width, Math.max(tallest.get(width) ?? 0, layoutHeight))
  const inset = vv ? keyboardInset(layoutHeight, vv) : 0
  root.style.setProperty('--app-height', `${Math.round(vv ? vv.height : layoutHeight)}px`)
  root.style.setProperty('--vv-top', `${Math.round(vv?.offsetTop ?? 0)}px`)
  root.style.setProperty('--keyboard-inset', `${inset}px`)
  const open = isKeyboardOpen({
    inset,
    layoutHeight,
    tallest: tallest.get(width) ?? layoutHeight,
    editing: isTextField(document.activeElement),
  })
  if (open === keyboardOpen) return
  keyboardOpen = open
  root.classList.toggle('is-keyboard-open', open)
  for (const listener of listeners) listener(open)
}

export function initViewport() {
  update()
  window.visualViewport?.addEventListener('resize', update)
  window.visualViewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  window.addEventListener('orientationchange', () => {
    tallest.clear()
    setTimeout(update, 300)
  })
  // Focus moves before the keyboard animates; check again once it settled.
  document.addEventListener('focusin', () => setTimeout(update, 350))
  document.addEventListener('focusout', () => setTimeout(update, 50))
}
