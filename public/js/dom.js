import { MOBILE_QUERY, TOUCH_QUERY } from './touch.js'

/**
 * @template {Element} [T=HTMLElement]
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {T}
 */
export function $(selector, root = document) {
  const el = root.querySelector(selector)
  if (!el) throw new Error(`missing element ${selector}`)
  return /** @type {T} */ (el)
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c])
}

export function icon(id, size = 'sm') {
  return `<svg class="icon icon-${size}" aria-hidden="true"><use href="#i-${id}"/></svg>`
}

export function isNearBottom(el, slack = 140) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack
}

export function autosize(textarea) {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`
  // Every change made in code ends here: what is drawn under the text (attachment tokens) follows.
  textarea.dispatchEvent(new Event('autosize'))
}

// navigator.clipboard needs a secure context; plain http on a LAN falls back to execCommand.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {}
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.append(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  return ok
}

function fromHtml(html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = html.trim()
  return /** @type {HTMLElement} */ (tpl.content.firstElementChild)
}

const rendered = new WeakMap()

/**
 * Keyed patch of a container's children: blocks whose HTML did not change keep their DOM node,
 * so text selection, focus and scroll anchoring survive the 1-3 s thread polls.
 * @param {HTMLElement} container
 * @param {{ key: string; html: string }[]} blocks each html must render exactly one element
 */
export function patchKeyed(container, blocks) {
  /** @type {Map<string, Element>} */
  const existing = new Map()
  for (const el of container.children) existing.set(/** @type {HTMLElement} */ (el).dataset.key ?? '', el)
  /** @type {Element | null} */
  let prev = null
  for (const block of blocks) {
    let el = existing.get(block.key)
    existing.delete(block.key)
    if (!el || rendered.get(el) !== block.html) {
      const next = fromHtml(block.html)
      next.dataset.key = block.key
      rendered.set(next, block.html)
      if (el) el.replaceWith(next)
      el = next
    }
    const want = prev ? prev.nextElementSibling : container.firstElementChild
    if (want !== el) container.insertBefore(el, want)
    prev = el
  }
  for (const el of existing.values()) el.remove()
}

export function rovingFocus(event, items, { vertical = true } = {}) {
  const list = [...items]
  if (!list.length) return false
  const index = list.indexOf(/** @type {HTMLElement} */ (document.activeElement))
  const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft'
  const nextKey = vertical ? 'ArrowDown' : 'ArrowRight'
  let next = -1
  if (event.key === nextKey) next = (index + 1) % list.length
  else if (event.key === prevKey) next = (index - 1 + list.length) % list.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = list.length - 1
  if (next < 0) return false
  event.preventDefault()
  list[next].focus()
  return true
}

export const narrowQuery = window.matchMedia(MOBILE_QUERY)
export const isNarrow = () => narrowQuery.matches
export const touchQuery = window.matchMedia(TOUCH_QUERY)
export const isTouch = () => touchQuery.matches

const shownHtml = new WeakMap()

/** Like `innerHTML =`, but leaves the element alone when the markup is unchanged (state ticks every second). */
export function setHtml(el, html) {
  if (shownHtml.get(el) === html) return
  shownHtml.set(el, html)
  el.innerHTML = html
}
