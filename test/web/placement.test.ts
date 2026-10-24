import { describe, expect, test } from 'bun:test'
import { placePopup } from '../../public/js/placement.js'

const view = { top: 0, bottom: 800 }

describe('placePopup', () => {
  test('goes above the anchor when it fits there', () => {
    expect(placePopup({ top: 700, bottom: 760 }, view, 300)).toEqual({ top: 394, maxHeight: 300, below: false })
  })

  test('flips below when there is no room above', () => {
    expect(placePopup({ top: 120, bottom: 200 }, view, 300)).toEqual({ top: 206, maxHeight: 300, below: true })
  })

  test('caps the height on the roomier side when it fits on neither', () => {
    const place = placePopup({ top: 300, bottom: 360 }, view, 600)
    expect(place.below).toBe(true)
    expect(place.top).toBe(366)
    expect(place.maxHeight).toBe(426)
    expect(place.top + place.maxHeight).toBeLessThanOrEqual(view.bottom)
  })

  test('stays inside a band shrunk by an on-screen keyboard', () => {
    const band = { top: 100, bottom: 500 }
    const place = placePopup({ top: 420, bottom: 480 }, band, 500)
    expect(place.below).toBe(false)
    expect(place.top).toBeGreaterThanOrEqual(band.top)
    expect(place.top + place.maxHeight).toBeLessThanOrEqual(420 - 6)
  })
})
