import { $, esc, icon, isNarrow, isTouch, rovingFocus } from './dom.js'

/**
 * @typedef {{ header: string }} MenuHeader
 * @typedef {{ note: string }} MenuNote a line of explanation, not an action
 * @typedef {{ separator: true }} MenuSeparator
 * @typedef {{ label: string; icon?: string; hint?: string; hintTone?: 'good'; checked?: boolean; run: () => unknown }} MenuAction
 * @typedef {MenuHeader | MenuNote | MenuSeparator | MenuAction} MenuItem
 * @typedef {HTMLElement | { x: number; y: number }} MenuAnchor
 */

let anchorEl = null
let items = []

const menuEl = () => $('#menu')

export function closeMenu({ restoreFocus = false } = {}) {
  const el = menuEl()
  if (el.hidden) return false
  el.hidden = true
  el.classList.remove('is-sheet')
  $('#sheet-scrim').hidden = true
  anchorEl?.setAttribute('aria-expanded', 'false')
  if (restoreFocus) anchorEl?.focus()
  anchorEl = null
  return true
}

/**
 * Opens the shared popup menu below (or above) an element or at a pointer position.
 * Clicking the same anchor again closes it.
 * @param {MenuAnchor} anchor
 * @param {(MenuItem | false | null | undefined)[]} list falsy entries are skipped
 */
export function openMenu(anchor, list) {
  const el = menuEl()
  if (!el.hidden && anchor === anchorEl) return closeMenu()
  closeMenu()
  items = list.filter(Boolean)
  el.innerHTML = items
    .map((it, i) => {
      if ('header' in it) return `<div class="menu-header" role="presentation">${esc(it.header)}</div>`
      if ('note' in it) return `<p class="menu-note">${esc(it.note)}</p>`
      if ('separator' in it) return '<div class="menu-separator" role="separator"></div>'
      const role = it.checked === undefined ? 'menuitem' : 'menuitemradio'
      const checked = it.checked === undefined ? '' : ` aria-checked="${it.checked}"`
      return `<button type="button" class="menu-item" role="${role}"${checked} data-index="${i}" tabindex="-1">${it.icon ? icon(it.icon) : ''}<span class="menu-label">${esc(it.label)}</span>${it.hint ? `<span class="menu-hint${it.hintTone === 'good' ? ' is-good' : ''}">${esc(it.hint)}</span>` : ''}${it.checked ? icon('check', 'xs') : ''}</button>`
    })
    .join('')
  el.hidden = false
  anchorEl = anchor instanceof HTMLElement ? anchor : null
  anchorEl?.setAttribute('aria-expanded', 'true')
  if (isNarrow()) return openSheet(el)
  const rect =
    anchor instanceof HTMLElement
      ? anchor.getBoundingClientRect()
      : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y }
  const width = el.offsetWidth
  const height = el.offsetHeight
  let top = rect.bottom + 6
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6)
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
  el.style.top = `${top}px`
  focusFirst(el)
}

// On a phone a menu is a bottom sheet over a backdrop: reachable with a thumb and never off screen.
function openSheet(el) {
  el.classList.add('is-sheet')
  el.style.left = ''
  el.style.top = ''
  $('#sheet-scrim').hidden = false
  el.scrollTop = 0
  // Focusing an item would close the on-screen keyboard under a menu opened from the composer.
  if (!isTouch()) focusFirst(el)
}

function focusFirst(el) {
  const first = el.querySelector('.menu-item[aria-checked="true"]') || el.querySelector('.menu-item')
  first?.focus({ preventScroll: true })
}

function runItem(index) {
  const item = items[index]
  closeMenu({ restoreFocus: true })
  item?.run?.()
}

export function initMenus() {
  const el = menuEl()
  el.addEventListener('click', e => {
    const button = e.target.closest('[data-index]')
    if (button) runItem(Number(button.dataset.index))
  })
  el.addEventListener('keydown', e => {
    if (rovingFocus(e, el.querySelectorAll('.menu-item'))) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeMenu({ restoreFocus: true })
    } else if (e.key === 'Tab') closeMenu()
  })
  $('#sheet-scrim').addEventListener('click', () => closeMenu())
  document.addEventListener('pointerdown', e => {
    if (el.hidden || el.contains(e.target) || e.target.id === 'sheet-scrim') return
    if (anchorEl?.contains(e.target)) return
    closeMenu()
  })
  // A sheet stays open while the keyboard opens or closes under it.
  window.addEventListener('resize', () => el.classList.contains('is-sheet') || closeMenu())
}
