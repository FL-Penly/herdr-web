import { postAction } from './api.js'
import { confirmDialog } from './dialog.js'
import { $, esc, icon, rovingFocus } from './dom.js'
import { onLongPress } from './gestures.js'
import { newSessionKinds } from './home.js'
import { t } from './i18n/index.js'
import { DOUBLE_CLICK_MS, inflight, requestId } from './inflight.js'
import { openMenu } from './menus.js'
import { statusDotClass, tabInfo } from './model.js'
import { goHome, selectPane } from './navigation.js'
import { openPaneMenu } from './pane-menu.js'
import { kindMarkHtml } from './sidebar.js'
import { agentBy, state, terminalBy, workspaceBy } from './state.js'

const tabDisplay = tab => {
  const info = tabInfo(tab, { agentBy, terminalBy, home: state.home })
  return { ...info, name: info.name || t('terminal.untitled') }
}

const selectedPaneView = () => agentBy(state.selected) || terminalBy(state.selected)
const tabsOf = workspace => state.tabs.filter(x => x.workspace === workspace).sort((a, b) => a.number - b.number)

let renderedSignature = ''

export function renderTabs() {
  const box = $('#tabs')
  const current = selectedPaneView()
  if (!current) {
    box.innerHTML = ''
    renderedSignature = ''
    return
  }
  const html = tabsOf(current.workspace)
    .map(tab => {
      const { name, agent } = tabDisplay(tab)
      const active = tab.panes.includes(state.selected)
      const lead = agent ? `<span class="${statusDotClass(agent)}" aria-hidden="true"></span>` : icon('term')
      const kind = agent ? kindMarkHtml(agent.kind) : ''
      const splits =
        tab.panes.length > 1
          ? `<span class="tab-splits" title="${esc(t('tabs.splits', { n: tab.panes.length }))}">${tab.panes.length}</span>`
          : ''
      return `<div class="tab${active ? ' is-active' : ''}" data-tab="${esc(tab.id)}">
        <button type="button" class="tab-main" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}" title="${esc(name)}">${lead}<span class="tab-name">${esc(name)}</span>${kind}${splits}</button>
        <button type="button" class="tab-close" data-close="${esc(tab.id)}" aria-label="${esc(t('tabs.close', { name }))}" title="${esc(t('tabs.closeShort'))}">${icon('x', 'xs')}</button>
      </div>`
    })
    .join('')
  const signature = html + state.selected
  if (signature === renderedSignature) return
  renderedSignature = signature
  box.innerHTML = `<div class="tab-list" role="tablist" aria-label="${esc(t('tabs.label'))}">${html}</div><button type="button" class="icon-btn icon-btn-sm" id="tab-add" aria-label="${esc(t('tabs.add'))}" title="${esc(t('tabs.add'))}" aria-haspopup="menu">${icon('plus')}</button>`
  box.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

async function closeTab(tabId) {
  const tab = state.tabs.find(x => x.id === tabId)
  if (!tab) return
  const ok = await confirmDialog({
    title: t('tabs.confirmTitle', { name: tabDisplay(tab).name }),
    body: t('tabs.confirmBody'),
    confirmLabel: t('tabs.closeShort'),
    danger: true,
  })
  if (!ok) return
  const siblings = tabsOf(tab.workspace)
  const index = siblings.indexOf(tab)
  const next = siblings[index + 1] || siblings[index - 1]
  const wasActive = tab.panes.includes(state.selected)
  if ((await postAction({ op: 'closeTab', tab: tab.id }, t('toast.tabClosed'))) && wasActive) {
    if (next) selectPane(tabDisplay(next).main)
    else goHome()
  }
}

function openAddMenu(anchor) {
  const current = selectedPaneView()
  if (!current) return
  const create = agent => () =>
    inflight.run(
      'new',
      async () => {
        const result = await postAction({
          op: 'new',
          workspace: current.workspace,
          cwd: current.cwd,
          ...(agent ? { agent } : {}),
          request: requestId(),
        })
        if (result?.pane) state.pendingSelect = { pane: result.pane, agent: !!agent, at: Date.now() }
      },
      DOUBLE_CLICK_MS,
    )
  openMenu(anchor, [
    { header: t('tabs.newIn', { name: workspaceBy(current.workspace)?.label ?? '' }) },
    ...newSessionKinds().map(({ kind, label, icon }) => ({ label, icon, run: create(kind === 'shell' ? null : kind) })),
  ])
}

function activateTab(tabId) {
  const tab = state.tabs.find(x => x.id === tabId)
  if (!tab) return
  if (tab.panes.includes(state.selected)) {
    if (tab.panes.length > 1) selectPane(tab.panes[(tab.panes.indexOf(state.selected) + 1) % tab.panes.length])
    return
  }
  selectPane(tabDisplay(tab).main)
}

export function initTabs() {
  const box = $('#tabs')
  box.addEventListener('click', e => {
    const close = e.target.closest('[data-close]')
    if (close) return closeTab(close.dataset.close)
    const add = e.target.closest('#tab-add')
    if (add) return openAddMenu(add)
    const tab = e.target.closest('[data-tab]')
    if (tab) activateTab(tab.dataset.tab)
  })
  const openTabMenu = (el, point) => {
    const tab = state.tabs.find(x => x.id === el.dataset.tab)
    if (tab) openPaneMenu(point, tab.panes.includes(state.selected) ? state.selected : tabDisplay(tab).main)
    return !!tab
  }
  onLongPress(box, '[data-tab]', openTabMenu)
  box.addEventListener('contextmenu', e => {
    const el = e.target.closest('[data-tab]')
    if (el && openTabMenu(el, { x: e.clientX, y: e.clientY })) e.preventDefault()
  })
  box.addEventListener('keydown', e => {
    if (e.target.closest('[role="tab"]')) rovingFocus(e, box.querySelectorAll('[role="tab"]'), { vertical: false })
  })
}
