import { getJson, isUnauthorized } from './api.js'
import { $, esc, icon, isNarrow, isTouch, rovingFocus } from './dom.js'
import { commonPrefix, elidePath, shortCwd } from './format.js'
import { t } from './i18n/index.js'
import { closeMenu } from './menus.js'
import { state } from './state.js'
import { save } from './storage.js'

const COMPLETE_DEBOUNCE_MS = 140

/** @type {{ recent: string[]; home: string } | null} */
let choices = null
let onPick = () => {}
let completeTimer = null
let completeSeq = 0
let anchorEl = null

const picker = () => $('#dir-picker')
const input = () => $('#dir-input')

/** The folder a new session starts in: the one picked, else the most recent one, else home. */
export function homeDir() {
  return state.homeDir || choices?.recent[0] || state.home
}

/** Set the folder; the workspace is worked out from it again unless `keepWorkspace`. */
export function setHomeDir(dir, { keepWorkspace = false } = {}) {
  state.homeDir = dir
  save('homeDir', dir)
  if (keepWorkspace) return
  state.homeWorkspace = null
  state.homeNewName = null
}

export async function loadDirChoices() {
  try {
    const body = await getJson('/api/dirs')
    choices = { recent: body.recent ?? [], home: body.home ?? '' }
  } catch (err) {
    if (!isUnauthorized(err)) choices = null
  }
  return choices
}

export function rememberDir(dir) {
  if (choices) choices.recent = [dir, ...choices.recent.filter(d => d !== dir)]
}

const homeOf = () => choices?.home || state.home

function itemHtml(dir, { current = false, fill = false } = {}) {
  const action = fill ? 'data-fill' : 'data-pick'
  return `<button type="button" class="menu-item dir-item" role="option" aria-selected="${current}" ${action}="${esc(dir)}" title="${esc(dir)}">${icon('folder')}<span class="menu-label">${esc(elidePath(shortCwd(dir, homeOf()), 56))}</span>${current ? icon('check', 'xs') : ''}</button>`
}

function renderRecent() {
  const current = homeDir()
  const recent = choices?.recent ?? []
  const list = recent.length ? recent : current ? [current] : []
  $('#dir-list').innerHTML =
    `<div class="menu-header">${esc(t('dir.recent'))}</div>` +
    (list.map(dir => itemHtml(dir, { current: dir === current })).join('') ||
      `<div class="dir-empty">${esc(t('dir.none'))}</div>`)
}

function renderCompletions(dirs) {
  $('#dir-list').innerHTML = dirs.length
    ? `<div class="menu-header">${esc(t('dir.matching'))}</div>${dirs.map(dir => itemHtml(dir, { fill: true })).join('')}`
    : `<div class="dir-empty">${esc(t('dir.noMatch'))}</div>`
}

let lastCompletions = []

async function complete(path) {
  const seq = ++completeSeq
  let dirs = []
  try {
    dirs = (await getJson('/api/complete', { path })).dirs ?? []
  } catch {}
  if (seq !== completeSeq || picker().hidden) return
  lastCompletions = dirs
  renderCompletions(dirs)
}

function onInput() {
  clearTimeout(completeTimer)
  const value = input().value.trim()
  if (!value) {
    lastCompletions = []
    return renderRecent()
  }
  completeTimer = setTimeout(() => complete(value), COMPLETE_DEBOUNCE_MS)
}

// A folder chosen from a completion is opened, to go on into its subfolders; "Use" takes what the field holds.
function fill(dir) {
  const el = input()
  el.value = `${dir.replace(/\/+$/, '')}/`
  el.focus()
  clearTimeout(completeTimer)
  complete(el.value)
}

/** Whether `path` names an existing folder: completing it lists the folder itself. */
async function isDir(path) {
  const home = homeOf()
  const full = path.replace(/^~(?=$|\/)/, home).replace(/(.)\/+$/, '$1')
  try {
    const { dirs = [] } = await getJson('/api/complete', { path: full })
    return full === home || full === '/' || dirs.some(d => d.replace(/(.)\/+$/, '$1') === full)
  } catch {
    // Unknown: let the server decide when the session starts (it answers bad_cwd).
    return true
  }
}

function pick(dir) {
  const path = dir.trim().replace(/(.)\/+$/, '$1')
  if (!path) return
  setHomeDir(path)
  closeDirPicker()
  onPick()
}

export function closeDirPicker({ restoreFocus = false } = {}) {
  const el = picker()
  if (el.hidden) return false
  el.hidden = true
  el.classList.remove('is-sheet')
  $('#sheet-scrim').hidden = true
  anchorEl?.setAttribute('aria-expanded', 'false')
  if (restoreFocus) anchorEl?.focus()
  anchorEl = null
  clearTimeout(completeTimer)
  completeSeq++
  return true
}

export async function openDirPicker(anchor) {
  const el = picker()
  if (!el.hidden) return closeDirPicker()
  closeMenu()
  anchorEl = anchor
  anchor.setAttribute('aria-expanded', 'true')
  input().value = ''
  lastCompletions = []
  renderRecent()
  el.hidden = false
  if (isNarrow()) {
    el.classList.add('is-sheet')
    el.style.left = ''
    el.style.top = ''
    $('#sheet-scrim').hidden = false
  } else {
    const rect = anchor.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`
    el.style.top = `${rect.bottom + 6}px`
  }
  // On a phone the keyboard would cover the recent folders; the field is one tap away.
  if (!isTouch()) input().focus()
  if ((await loadDirChoices()) && !el.hidden && !input().value.trim()) renderRecent()
}

export function initDirPicker({ onPick: picked_ }) {
  onPick = picked_
  const el = picker()
  input().addEventListener('input', onInput)
  input().addEventListener('keydown', e => {
    if (e.key === 'Tab' && lastCompletions.length) {
      e.preventDefault()
      const prefix = commonPrefix(lastCompletions)
      if (lastCompletions.length === 1) fill(lastCompletions[0])
      else if (prefix.length > input().value.length) {
        input().value = prefix
        onInput()
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      el.querySelector('.dir-item')?.focus()
    }
  })
  $('#dir-form').addEventListener('submit', async e => {
    e.preventDefault()
    const typed = input().value.trim()
    if (!typed) return
    clearTimeout(completeTimer)
    completeSeq++
    // A typed path is checked here, so a typo is caught in the picker rather than as a failed send.
    if (await isDir(typed)) pick(typed)
    else if (!picker().hidden) {
      lastCompletions = []
      $('#dir-list').innerHTML = `<div class="dir-empty">${esc(t('dir.missing'))}</div>`
    }
  })
  $('#dir-list').addEventListener('click', e => {
    const item = e.target.closest('[data-pick], [data-fill]')
    if (!item) return
    if (item.dataset.fill) fill(item.dataset.fill)
    else pick(item.dataset.pick)
  })
  el.addEventListener('keydown', e => {
    if (e.target !== input() && rovingFocus(e, el.querySelectorAll('.dir-item'))) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeDirPicker({ restoreFocus: true })
    }
  })
  $('#sheet-scrim').addEventListener('click', () => closeDirPicker())
  document.addEventListener('pointerdown', e => {
    if (el.hidden || el.contains(e.target) || e.target.id === 'sheet-scrim' || anchorEl?.contains(e.target)) return
    closeDirPicker()
  })
}
