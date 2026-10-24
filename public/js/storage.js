// @ts-check

const STORAGE_PREFIX = 'herdr-web:'

// Storage can throw (private mode, blocked site data); preferences then just don't persist.
/**
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key)
    return raw == null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 */
export function save(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value))
  } catch {}
}

/** @type {Record<string, string>} */
let drafts = load('drafts', {})

/** @param {string} pane */
export const draftFor = pane => drafts[pane] ?? ''

/**
 * @param {string} pane
 * @param {string} text
 */
export function saveDraft(pane, text) {
  if (text) drafts[pane] = text
  else delete drafts[pane]
  save('drafts', drafts)
}

/**
 * Forgets drafts of panes that no longer exist so storage does not grow without bound.
 * @param {Set<string>} livePanes
 */
export function pruneDrafts(livePanes) {
  if (!livePanes.size) return
  const kept = Object.fromEntries(Object.entries(drafts).filter(([pane]) => livePanes.has(pane)))
  if (Object.keys(kept).length === Object.keys(drafts).length) return
  drafts = kept
  save('drafts', drafts)
}
