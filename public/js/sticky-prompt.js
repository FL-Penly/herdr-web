// @ts-check
import { $ } from './dom.js'
import { turnPrompts } from './model.js'
import { state } from './state.js'

const scroller = () => $('#conversation')
let prompts = /** @type {{ id: string; preview: string }[]} */ ([])
let frame = 0

/** @param {string} id */
const promptEl = id =>
  /** @type {HTMLElement | null} */ (
    $('#turns').querySelector(
      `[data-key="turn:${CSS.escape(id)}"] .msg-user, [data-key="turn:${CSS.escape(id)}"] .system-note`,
    )
  )

/** Redrawn after the thread renders; follows scrolling from there. */
export function renderStickyPrompt() {
  prompts = state.thread ? turnPrompts(state.thread.turns) : []
  showSticky()
}

// The prompt of the turn being read, pinned above the thread once it has scrolled out of view (as Cursor does);
// a click goes back to it.
function showSticky() {
  const el = /** @type {HTMLButtonElement} */ ($('#sticky-prompt'))
  const box = scroller()
  const top = box.getBoundingClientRect().top + 4
  // The turn at the top edge of the view, if its prompt is above it.
  const shown = box.hidden
    ? null
    : prompts.find(m => {
        const turn = $('#turns')
          .querySelector(`[data-key="turn:${CSS.escape(m.id)}"]`)
          ?.getBoundingClientRect()
        const prompt = promptEl(m.id)?.getBoundingClientRect()
        return !!turn && !!prompt && !!m.preview && turn.top <= top && turn.bottom > top && prompt.bottom < top
      })
  el.hidden = !shown
  if (!shown || el.dataset.message === shown.id) return
  el.dataset.message = shown.id
  el.textContent = shown.preview
}

/** @param {string} id */
function jumpTo(id) {
  const target = promptEl(id)
  if (!target) return
  const box = scroller()
  box.scrollTo({ top: target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 16 })
}

export function initStickyPrompt() {
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        showSticky()
      })
    }
  }
  scroller().addEventListener('scroll', schedule, { passive: true })
  new ResizeObserver(schedule).observe(scroller())
  $('#sticky-prompt').addEventListener('click', e => {
    const id = /** @type {HTMLElement} */ (e.currentTarget).dataset.message
    if (id) jumpTo(id)
  })
}
