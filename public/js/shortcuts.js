import { cancelDialog, chooseOption } from './cards.js'
import { infoDialog } from './dialog.js'
import { closeDirPicker } from './dirs.js'
import { $, esc } from './dom.js'
import { kbd, t } from './i18n/index.js'
import { closeMenu } from './menus.js'
import { hasBlockingDialog, optionForDigit } from './model.js'
import { currentView, goHome, isPaneViewOpen, toggleView } from './navigation.js'
import { closePalette, togglePalette } from './palette.js'
import { forkSession } from './pane-menu.js'
import { isMac } from './platform.js'
import { setReviewOpen } from './review.js'
import { closeDrawer, toggleSidebar } from './sidebar.js'
import { closeSlash } from './slash.js'
import { agentBy, selectedAgent, state } from './state.js'

const modPressed = e => (isMac ? e.metaKey : e.ctrlKey)

const SHORTCUTS = [
  {
    keys: 'mod+K',
    label: 'shortcuts.palette',
    when: e => modPressed(e) && e.key.toLowerCase() === 'k',
    run: togglePalette,
  },
  {
    keys: 'mod+B',
    label: 'shortcuts.sidebar',
    when: e => modPressed(e) && e.key.toLowerCase() === 'b',
    run: toggleSidebar,
  },
  {
    keys: 'mod+J',
    label: 'shortcuts.view',
    when: e => modPressed(e) && e.key.toLowerCase() === 'j' && !!state.selected && isPaneViewOpen(),
    run: toggleView,
  },
  { keys: 'alt+N', label: 'shortcuts.newSession', when: e => e.altKey && e.code === 'KeyN', run: () => goHome() },
  {
    keys: 'alt+F',
    label: 'shortcuts.fork',
    when: e => e.altKey && e.code === 'KeyF' && !!agentBy(state.selected),
    run: () => forkSession('tab'),
  },
]

const HELP_ONLY = [
  { keys: '1-9', label: 'shortcuts.option' },
  { keys: 'Esc', label: 'shortcuts.cancelDialog' },
  { keys: 'ctrl+]', label: 'shortcuts.leaveTerminal' },
]

export function showShortcuts() {
  const rows = [...SHORTCUTS, ...HELP_ONLY]
    .map(
      s => `<tr><td><kbd>${esc(/[+]/.test(s.keys) ? kbd(s.keys) : s.keys)}</kbd></td><td>${esc(t(s.label))}</td></tr>`,
    )
    .join('')
  infoDialog({ title: t('shortcuts.title'), html: `<table class="shortcut-table">${rows}</table>` })
}

const isEditable = el =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

// Escape closes the topmost popup and stops there: it must never also reach a blocked agent's dialog.
function closeTopPopup() {
  return (
    closeMenu({ restoreFocus: true }) ||
    closeDirPicker({ restoreFocus: true }) ||
    closeSlash() ||
    closePalette() ||
    closeDrawer()
  )
}

function closeTextView() {
  const view = $('#term-text')
  if (view.hidden) return false
  view.hidden = true
  return true
}

function closeReview() {
  if (!state.reviewOpen) return false
  setReviewOpen(false)
  return true
}

function closeDialog() {
  const dialog = document.querySelector('dialog[open]')
  dialog?.close()
  return !!dialog
}

/** What the phone's Back closes, topmost first. */
export const closeTopLayer = () => closeDialog() || closeTopPopup() || closeTextView() || closeReview()

function onKeydown(e) {
  if (document.querySelector('dialog[open]')) return
  const shortcut = SHORTCUTS.find(s => s.when(e))
  if (shortcut) {
    e.preventDefault()
    shortcut.run()
    return
  }
  if (e.key === 'Escape' && closeTopPopup()) {
    e.preventDefault()
    return
  }
  if (e.target.closest?.('#term') || isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
  const agent = selectedAgent()
  if (!agent || !isPaneViewOpen() || currentView() !== 'chat') return
  const option = /^[1-9]$/.test(e.key) && hasBlockingDialog(agent) && optionForDigit(agent.inbox.options, e.key)
  if (option) {
    e.preventDefault()
    chooseOption(option, { okMessage: t('toast.selectedKey', { key: e.key }) })
    return
  }
  // A blocked agent without parsed options can still be cancelled.
  if (e.key === 'Escape' && agent.status === 'blocked') {
    cancelDialog()
    return
  }
  if (e.key.length === 1 && !e.isComposing) $('#reply-text').focus()
}

export function initShortcuts() {
  document.addEventListener('keydown', onKeydown)
}
