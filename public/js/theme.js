import { load, save } from './storage.js'

export const THEME_MODES = ['system', 'light', 'dark']
const listeners = new Set()
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

let mode = load('theme', 'system')

export const themeMode = () => mode
export const isDark = () => (mode === 'system' ? darkQuery.matches : mode === 'dark')

export function onThemeChange(listener) {
  listeners.add(listener)
}

function apply() {
  const root = document.documentElement
  if (mode === 'system') delete root.dataset.theme
  else root.dataset.theme = mode
  const bg = resolveColor('--color-bg')
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = bg
  for (const listener of listeners) listener()
}

export function setThemeMode(next) {
  mode = THEME_MODES.includes(next) ? next : 'system'
  save('theme', mode)
  apply()
}

export function initTheme() {
  if (!THEME_MODES.includes(mode)) mode = 'system'
  darkQuery.addEventListener('change', () => mode === 'system' && apply())
  apply()
}

let probe = null

// Tokens use light-dark(), which custom-property reads return unresolved; a probe element yields the computed rgb().
function resolveColor(token) {
  if (!probe) {
    probe = document.createElement('span')
    probe.style.display = 'none'
    document.body.append(probe)
  }
  probe.style.color = `var(${token})`
  return getComputedStyle(probe).color
}

const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
]

export function terminalTheme() {
  const kebab = name => name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)
  const theme = {
    background: resolveColor('--term-bg'),
    foreground: resolveColor('--term-fg'),
    cursor: resolveColor('--term-cursor'),
    cursorAccent: resolveColor('--term-bg'),
    selectionBackground: resolveColor('--term-selection'),
  }
  for (const name of ANSI) theme[name] = resolveColor(`--term-${kebab(name)}`)
  return theme
}
