import { $, esc, icon } from './dom.js'
import { kbd, t } from './i18n/index.js'
import { inboxReasonLabel, terminalLabel } from './labels.js'
import { agentTitle, needList } from './model.js'
import { goHome, selectPane } from './navigation.js'
import { renderSidebar } from './sidebar.js'
import { state, workspaceBy } from './state.js'

const MAX_ITEMS = 50
let items = []
let index = 0
let returnFocus = null

const overlay = () => $('#palette')
const input = () => $('#palette-input')
const isPaletteOpen = () => !overlay().hidden

export function openPalette() {
  returnFocus = document.activeElement
  overlay().hidden = false
  input().value = ''
  index = 0
  render()
  input().focus()
}

export function closePalette() {
  if (overlay().hidden) return false
  overlay().hidden = true
  returnFocus?.focus()
  return true
}

export const togglePalette = () => (isPaletteOpen() ? closePalette() : openPalette())

function allItems() {
  return [
    { label: t('nav.newSession'), icon: 'new', hint: kbd('alt+N'), run: goHome },
    {
      label: t('palette.needsOnly'),
      icon: 'inbox',
      hint: String(needList(state.agents).length),
      run: () => {
        state.needsOnly = true
        renderSidebar()
      },
    },
    ...state.agents.map(a => ({
      label: agentTitle(a),
      icon: a.status === 'working' ? 'cpu' : a.inbox ? 'q' : 'chat',
      hint: `${a.workspaceLabel}${a.inbox ? ` · ${inboxReasonLabel(a.inbox)}` : ''}`,
      keywords: `${a.cwd} ${a.branch?.name ?? ''} ${a.name ?? ''}`,
      run: () => selectPane(a.pane),
    })),
    ...state.terminals.map(term => ({
      label: terminalLabel(term, state.home),
      icon: 'term',
      hint: workspaceBy(term.workspace)?.label ?? '',
      keywords: term.cwd,
      run: () => selectPane(term.pane),
    })),
  ]
}

function render() {
  const query = input().value.trim().toLowerCase()
  items = allItems()
    .filter(it => !query || `${it.label} ${it.hint ?? ''} ${it.keywords ?? ''}`.toLowerCase().includes(query))
    .slice(0, MAX_ITEMS)
  index = Math.min(index, Math.max(0, items.length - 1))
  const list = $('#palette-list')
  list.innerHTML =
    items
      .map(
        (it, i) =>
          `<div class="palette-item" role="option" id="palette-${i}" data-index="${i}" aria-selected="${i === index}">${icon(it.icon)}<span class="palette-label">${esc(it.label)}</span><span class="palette-hint">${esc(it.hint ?? '')}</span></div>`,
      )
      .join('') || `<div class="empty-list">${esc(t('palette.noMatch'))}</div>`
  input().setAttribute('aria-activedescendant', items.length ? `palette-${index}` : '')
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
}

function runAt(i) {
  const item = items[i]
  closePalette()
  item?.run()
}

export function initPalette() {
  input().addEventListener('input', () => {
    index = 0
    render()
  })
  input().addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      index = e.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1)
      render()
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      runAt(index)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closePalette()
    }
  })
  $('#palette-list').addEventListener('click', e => {
    const item = e.target.closest('[data-index]')
    if (item) runAt(Number(item.dataset.index))
  })
  overlay().addEventListener('click', e => {
    if (e.target === overlay()) closePalette()
  })
}
