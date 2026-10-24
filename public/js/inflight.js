// @ts-check

/**
 * Lets one run per key happen at a time: a second click while the first request is out is dropped, so a
 * double click on Start, Fork or an option creates or answers once. The key is taken before anything awaits,
 * and held `hold` ms after the run ends: an answer can be in before the second click of the same double click
 * lands, and the next dialog may ask the very same question.
 * @param {(ms: number) => Promise<void>} [sleep]
 */
export function createGate(sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  /** @type {Set<string>} */
  const running = new Set()
  return {
    /**
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} fn
     * @param {number} [hold]
     * @returns {Promise<T | null>} null when `key` was already running (`fn` is not called)
     */
    async run(key, fn, hold = 0) {
      if (running.has(key)) return null
      running.add(key)
      try {
        return await fn()
      } finally {
        if (hold > 0) sleep(hold).then(() => running.delete(key))
        else running.delete(key)
      }
    },
    /** @param {string} key */
    busy: key => running.has(key),
  }
}

/** A double click's second click comes within this long of the first. */
export const DOUBLE_CLICK_MS = 600

/** The app's one gate: keys are `new`, `fork:<pane>`, `dialog:<pane>`, `ask:<pane>:<question>`. */
export const inflight = createGate()

let seq = 0
/** A fresh id for one click, sent as `request` so the server also drops a repeat (see `RequestId`). */
export const requestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${++seq}`
