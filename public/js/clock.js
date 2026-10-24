import { duration, relativeTime } from './format.js'
import { t } from './i18n/index.js'

export function refreshTimes(root = document) {
  const now = Date.now()
  const justNow = t('time.justNow')
  for (const el of root.querySelectorAll('[data-ts]')) {
    el.textContent = relativeTime(Number(el.dataset.ts), { now, justNow })
  }
  for (const el of root.querySelectorAll('[data-since]')) {
    el.textContent = duration(now - Number(el.dataset.since))
  }
}

export function timeHtml(ts, className = '') {
  return `<time class="${className}" data-ts="${ts}" datetime="${new Date(ts).toISOString()}" title="${new Date(ts).toLocaleString()}"></time>`
}

export const elapsedHtml = (since, className = '') => `<time class="${className}" data-since="${since}"></time>`

export function startClock() {
  setInterval(() => {
    const live = document.getElementById('live')
    if (live?.querySelector('[data-since]')) refreshTimes(live)
  }, 1000)
  setInterval(() => refreshTimes(document), 15_000)
}
