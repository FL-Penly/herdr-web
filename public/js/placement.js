// @ts-check

/**
 * Where a popup anchored to an input goes so that it always fits the visible area: above the anchor when
 * it fits there, else below when it fits there, else on the roomier side with its height capped (the popup
 * scrolls). Coordinates are viewport pixels; `view` is the visible band, which a phone's on-screen keyboard
 * makes shorter than the window.
 * @param {{ top: number; bottom: number }} anchor
 * @param {{ top: number; bottom: number }} view
 * @param {number} height the popup's natural height, already capped by its CSS; `maxHeight` never exceeds it
 * @param {{ gap?: number; margin?: number; min?: number }} [o]
 * @returns {{ top: number; maxHeight: number; below: boolean }}
 */
export function placePopup(anchor, view, height, { gap = 6, margin = 8, min = 96 } = {}) {
  const above = anchor.top - gap - (view.top + margin)
  const below = view.bottom - margin - (anchor.bottom + gap)
  const goBelow = height > above && (height <= below || below > above)
  const shown = Math.floor(Math.min(height, Math.max(min, goBelow ? below : above)))
  return { top: Math.round(goBelow ? anchor.bottom + gap : anchor.top - gap - shown), maxHeight: shown, below: goBelow }
}
