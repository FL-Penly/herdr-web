import { describe, expect, test } from 'bun:test'
import {
  KEYBOARD_MIN_PX,
  TERMINAL_FONT,
  clampTerminalFont,
  ctrlSequence,
  isKeyboardOpen,
  keyboardInset,
  scrollLines,
  stepTerminalFont,
  swipeIntent,
  withModifiers,
} from '../../public/js/touch.js'

describe('keyboard', () => {
  test('inset is what the visual viewport leaves of the layout one (iOS)', () => {
    expect(keyboardInset(844, { height: 844, offsetTop: 0 })).toBe(0)
    expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toBe(336)
    expect(keyboardInset(844, { height: 508, offsetTop: 120 })).toBe(216)
    expect(keyboardInset(844, { height: 900, offsetTop: 0 })).toBe(0)
  })

  test('open only while editing, from either the visual (iOS) or the layout viewport (Android)', () => {
    const base = { inset: 0, layoutHeight: 844, tallest: 844, editing: true }
    expect(isKeyboardOpen(base)).toBe(false)
    expect(isKeyboardOpen({ ...base, inset: 336 })).toBe(true)
    expect(isKeyboardOpen({ ...base, layoutHeight: 470 })).toBe(true)
    expect(isKeyboardOpen({ ...base, layoutHeight: 470, editing: false })).toBe(false)
    // The URL bar collapsing is not a keyboard.
    expect(isKeyboardOpen({ ...base, layoutHeight: 844 - KEYBOARD_MIN_PX + 1 })).toBe(false)
  })
})

describe('swipeIntent', () => {
  const edge = 156
  test('opens on a rightward swipe that starts in the edge zone', () => {
    expect(swipeIntent({ x: 20, y: 500 }, { x: 240, y: 510 }, { open: false, edge })).toBe('open')
    expect(swipeIntent({ x: 200, y: 500 }, { x: 380, y: 510 }, { open: false, edge })).toBeNull()
    expect(swipeIntent({ x: 20, y: 500 }, { x: 60, y: 500 }, { open: false, edge })).toBeNull()
  })

  test('closes on a leftward swipe when open; vertical moves are scrolls', () => {
    expect(swipeIntent({ x: 250, y: 500 }, { x: 40, y: 520 }, { open: true, edge })).toBe('close')
    expect(swipeIntent({ x: 250, y: 500 }, { x: 40, y: 520 }, { open: false, edge })).toBeNull()
    expect(swipeIntent({ x: 20, y: 300 }, { x: 120, y: 500 }, { open: false, edge })).toBeNull()
    expect(swipeIntent({ x: 40, y: 500 }, { x: 250, y: 500 }, { open: true, edge })).toBeNull()
  })
})

test('scrollLines keeps the remainder and works both ways', () => {
  expect(scrollLines(0, 30, 40)).toEqual({ lines: 0, carry: 30 })
  expect(scrollLines(30, 30, 40)).toEqual({ lines: 1, carry: 20 })
  expect(scrollLines(0, -130, 40)).toEqual({ lines: -3, carry: -10 })
})

test('ctrlSequence maps letters and the classic punctuation, nothing else', () => {
  expect(ctrlSequence('c')).toBe('\x03')
  expect(ctrlSequence('C')).toBe('\x03')
  expect(ctrlSequence('a')).toBe('\x01')
  expect(ctrlSequence('[')).toBe('\x1b')
  expect(ctrlSequence(' ')).toBe('\x00')
  expect(ctrlSequence('?')).toBe('\x7f')
  expect(ctrlSequence('1')).toBeNull()
  expect(ctrlSequence('ab')).toBeNull()
  expect(ctrlSequence('\x1b[A')).toBeNull()
})

test('clampTerminalFont rounds into the allowed range', () => {
  expect(clampTerminalFont(12.4)).toBe(12)
  expect(clampTerminalFont(2)).toBe(TERMINAL_FONT.min)
  expect(clampTerminalFont(99)).toBe(TERMINAL_FONT.max)
  expect(clampTerminalFont(Number.NaN)).toBe(TERMINAL_FONT.min)
})

describe('stepTerminalFont', () => {
  test('always moves the size on screen, also from a fitted fractional one', () => {
    expect(stepTerminalFont(7.3, 1)).toBe(8)
    expect(stepTerminalFont(11, 1)).toBe(12)
    expect(stepTerminalFont(11.6, -1)).toBe(11)
    expect(stepTerminalFont(TERMINAL_FONT.max, 1)).toBe(TERMINAL_FONT.max)
  })
})

test('withModifiers encodes held key-bar modifiers the way xterm does', () => {
  expect(withModifiers('a', {})).toBe('a')
  expect(withModifiers('c', { ctrl: true })).toBe('\x03')
  expect(withModifiers('a', { shift: true })).toBe('A')
  expect(withModifiers('b', { alt: true })).toBe('\x1bb')
  expect(withModifiers('x', { ctrl: true, alt: true })).toBe('\x1b\x18')
  expect(withModifiers('\x1b[A', { shift: true })).toBe('\x1b[1;2A')
  expect(withModifiers('\x1b[D', { ctrl: true })).toBe('\x1b[1;5D')
  expect(withModifiers('\x1b[C', { ctrl: true, alt: true, shift: true })).toBe('\x1b[1;8C')
  expect(withModifiers('\t', { shift: true })).toBe('\x1b[Z')
  expect(withModifiers('\r', { alt: true })).toBe('\x1b\r')
  expect(withModifiers('你', { ctrl: true })).toBe('你')
  expect(withModifiers('hello', { ctrl: true })).toBe('hello')
})
