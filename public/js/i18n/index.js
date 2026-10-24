// @ts-check
import { isMac } from '../platform.js'
import en from './en.js'
import zhCN from './zh-CN.js'

/**
 * A message, or its plural forms keyed by `Intl.PluralRules` category (`one`, `other`, …) and chosen by
 * the `n` variable. A locale without plurals (Chinese) just uses a string.
 * @typedef {string | Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }} Message
 */

/** @type {Record<string, Record<string, Message>>} */
const LOCALES = { en, 'zh-CN': zhCN }
export const LOCALE_NAMES = { en: 'English', 'zh-CN': '简体中文' }

/**
 * @param {string | null | undefined} requested
 * @param {readonly string[]} preferred e.g. navigator.languages
 */
export function pickLocale(requested, preferred) {
  if (requested && requested in LOCALES) return requested
  for (const tag of preferred) {
    if (/^zh\b/i.test(tag)) return 'zh-CN'
    if (/^en\b/i.test(tag)) return 'en'
  }
  return 'en'
}

let current = 'en'

export const locale = () => current

/** @param {string} next */
export function setLocale(next) {
  current = next in LOCALES ? next : 'en'
  return current
}

/** @param {string} key */
export const hasKey = key => key in LOCALES[current] || key in LOCALES.en

/**
 * @param {string} key
 * @param {Record<string, string | number>} [vars] `{name}` placeholders
 */
export function t(key, vars) {
  const message = LOCALES[current]?.[key] ?? LOCALES.en[key] ?? key
  const text = typeof message === 'string' ? message : pluralForm(message, current, vars?.n)
  return vars ? text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : text
}

/** @type {Map<string, Intl.PluralRules>} */
const pluralRules = new Map()

/**
 * @param {Exclude<Message, string>} forms
 * @param {string} lang
 * @param {string | number | undefined} n a formatted count such as `12K` is not a number and takes `other`
 */
export function pluralForm(forms, lang, n) {
  let rules = pluralRules.get(lang)
  if (!rules) pluralRules.set(lang, (rules = new Intl.PluralRules(lang)))
  const count = typeof n === 'number' ? n : Number(n)
  return (Number.isFinite(count) && forms[rules.select(count)]) || forms.other
}

/**
 * `mod+K` → `⌘K` on macOS, `Ctrl+K` elsewhere; `alt+N` → `⌥N` / `Alt+N`.
 * @param {string} combo
 * @param {boolean} [mac]
 */
export function kbd(combo, mac = isMac) {
  const parts = combo.split('+')
  const key = parts.pop()?.toUpperCase() ?? ''
  const names = mac
    ? { mod: '⌘', alt: '⌥', shift: '⇧', ctrl: '⌃' }
    : { mod: 'Ctrl', alt: 'Alt', shift: 'Shift', ctrl: 'Ctrl' }
  const mods = parts.map(p => names[/** @type {keyof typeof names} */ (p)] ?? p)
  return mac ? mods.join('') + key : [...mods, key].join('+')
}
