import { load, save } from '../storage.js'
import { kbd, pickLocale, setLocale, t } from './index.js'

export function initLocale() {
  const fromUrl = new URLSearchParams(location.search).get('lang')
  document.documentElement.lang = setLocale(
    pickLocale(fromUrl || load('lang', null), navigator.languages ?? [navigator.language]),
  )
}

export function changeLocale(code) {
  const applied = setLocale(code)
  save('lang', applied)
  document.documentElement.lang = applied
  applyI18n(document)
}

// Static markup opts in with data-i18n (text), data-i18n-<attr> (title, aria-label, placeholder) and data-kbd.
export function applyI18n(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n') ?? '')
  for (const attr of ['title', 'aria-label', 'placeholder']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`) ?? ''))
    }
  }
  for (const el of root.querySelectorAll('[data-kbd]')) el.textContent = kbd(el.getAttribute('data-kbd') ?? '')
}
