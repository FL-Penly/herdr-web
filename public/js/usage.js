// @ts-check
import { getJson } from './api.js'
import { $, esc, icon } from './dom.js'
import { duration } from './format.js'
import { t } from './i18n/index.js'
import { openMenu } from './menus.js'
import { USAGE_HOT, usageChip } from './model.js'
import { load, save } from './storage.js'

// Subscription usage (Settings): the limits of the Claude Code and Codex sign-ins on the server's machine, in a
// strip above the sidebar's footer. Off until turned on: asking sends those sign-ins to each provider.
const POLL_MS = 5 * 60_000

/** @type {import('../../src/protocol.ts').UsageReport | null} */
let report = null
let timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined)
let askedAt = 0

export const usageOn = () => load('usageMeter', /** @type {boolean} */ (false)) === true

/** @param {boolean} on */
export function setUsageMeter(on) {
  save('usageMeter', on)
  clearTimeout(timer)
  report = null
  if (on) void refresh()
  else render()
}

async function refresh(force = false) {
  clearTimeout(timer)
  if (!usageOn()) return
  askedAt = Date.now()
  try {
    report = await getJson('/api/usage', force ? { refresh: '1' } : {})
  } catch {
    // Kept as it was; the next poll tries again.
  }
  render()
  schedule()
}

// The next ask, POLL_MS after the last one; none while the page is hidden.
function schedule() {
  clearTimeout(timer)
  if (usageOn() && !document.hidden)
    timer = setTimeout(() => void refresh(), Math.max(0, askedAt + POLL_MS - Date.now()))
}

/** @param {'claude' | 'codex'} provider */
const providerName = provider => (provider === 'claude' ? 'Claude' : 'Codex')

/** @param {import('../../src/protocol.ts').UsageWindow} w */
function windowName(w) {
  const span = w.kind === 'session' ? t('usage.session') : t('usage.week')
  return w.scope ? `${span} · ${w.scope}` : span
}

/** @param {number} ms */
function until(ms) {
  const hours = Math.floor(ms / 3_600_000)
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : duration(ms)
}

/** @param {string | null} at */
const resetsIn = at => (at ? t('usage.resetsIn', { time: until(Date.parse(at) - Date.now()) }) : '')

function render() {
  const strip = $('#usage-strip')
  const accounts = usageOn() ? (report?.accounts ?? []) : []
  strip.hidden = !accounts.length
  if (!accounts.length) return strip.replaceChildren()
  strip.innerHTML = accounts
    .map(account => {
      const chip = usageChip(account)
      const name = account.label
        ? `${providerName(account.provider)} · ${account.label}`
        : providerName(account.provider)
      const value = account.problem === 'expired' ? t('usage.expired') : chip ? `${chip.left}%` : '–'
      const title = chip ? `${name}: ${t('usage.left', { n: chip.left })} · ${windowName(chip.window)}` : name
      const cls = account.problem === 'expired' || chip?.hot ? ' is-hot' : ''
      return `<span class="usage-chip${cls}" title="${esc(title)}">${icon(account.provider)}<span>${esc(value)}</span></span>`
    })
    .join('')
}

function openDetails() {
  const accounts = report?.accounts ?? []
  const items = accounts.flatMap(account => {
    const head = account.label ? `${providerName(account.provider)} · ${account.label}` : providerName(account.provider)
    const plan = account.plan ? ` (${account.plan})` : ''
    const problem = account.problem ? [{ note: t(`usage.${account.problem}Long`) }] : []
    const windows = account.windows.map(w => ({
      note: `${windowName(w)}: ${t('usage.used', { n: Math.round(w.usedPercent) })}${w.usedPercent >= USAGE_HOT ? ' ⚠' : ''}${w.resetsAt ? ` · ${resetsIn(w.resetsAt)}` : ''}`,
    }))
    return [{ header: `${head}${plan}` }, ...problem, ...windows]
  })
  openMenu(/** @type {HTMLElement} */ ($('#usage-strip')), [
    ...items,
    { separator: true },
    { label: t('usage.refresh'), icon: 'refresh', run: () => void refresh(true) },
  ])
}

export function initUsage() {
  const strip = $('#usage-strip')
  strip.addEventListener('click', openDetails)
  strip.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openDetails()
    }
  })
  // Asked only while someone looks: a page in the background stops polling, and catches up on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer)
    else if (usageOn() && Date.now() - askedAt >= POLL_MS) void refresh()
    else schedule()
  })
  if (usageOn()) void refresh()
}
