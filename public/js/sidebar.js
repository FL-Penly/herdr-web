import { postAction } from './api.js'
import { refreshTimes, timeHtml } from './clock.js'
import { promptDialog } from './dialog.js'
import { setHomeDir } from './dirs.js'
import { $, esc, icon, isNarrow } from './dom.js'
import { initDrawerSwipe, onLongPress } from './gestures.js'
import { t } from './i18n/index.js'
import { inboxReasonLabel, terminalLabel } from './labels.js'
import { openMenu } from './menus.js'
import {
  WORKSPACE_LABEL_RE,
  agentTitle,
  isAgentKind,
  isDone,
  kindLabel,
  kindShort,
  needList,
  pickHottest,
  statusDotClass,
  toggleAllGroups,
} from './model.js'
import { goHome, selectPane } from './navigation.js'
import { openPalette } from './palette.js'
import { openPaneMenu } from './pane-menu.js'
import { state, workspaceBy } from './state.js'
import { save } from './storage.js'
import { terminal } from './terminal.js'

let renderedHtml = ''

const byPane = (a, b) => a.pane.localeCompare(b.pane, undefined, { numeric: true })

export function statusLabel(agent) {
  if (agent.status === 'working') return t('status.working')
  if (agent.inbox) return inboxReasonLabel(agent.inbox)
  if (agent.status === 'blocked') return t('inbox.reason.blocked')
  if (isDone(agent)) return t('inbox.reason.done')
  return t('status.idle')
}

const dotHtml = agent =>
  `<span class="${statusDotClass(agent)}" role="img" aria-label="${esc(statusLabel(agent))}"></span>`

/** Which agent runs in the pane: its icon, or its short name for a kind without one. */
export function kindMarkHtml(kind) {
  const label = esc(kindLabel(kind))
  return isAgentKind(kind)
    ? `<span class="kind-mark kind-${kind}" role="img" aria-label="${label}" title="${label}">${icon(kind)}</span>`
    : `<span class="kind-mark" title="${label}">${esc(kindShort(kind))}</span>`
}

function rowHtml({ pane, lead, name, sub = '', right = '', title = '', terminalRow = false }) {
  const active = pane === state.selected
  return `<div class="thread-row${active ? ' is-active' : ''}${terminalRow ? ' is-terminal' : ''}" data-pane="${esc(pane)}">
    <button type="button" class="thread-main" data-action="open"${active ? ' aria-current="true"' : ''} title="${esc(title)}">${lead}<span class="thread-name">${name}${sub}</span>${right}</button>
    <button type="button" class="icon-btn icon-btn-xs thread-more" data-action="pane-menu" aria-label="${esc(t('sidebar.paneActions'))}" aria-haspopup="menu">${icon('more')}</button>
  </div>`
}

function agentRow(agent, flat) {
  const right = timeHtml(agent.since, 'thread-time')
  const sub = flat ? `<small>${esc(agent.workspaceLabel)} · ${esc(inboxReasonLabel(agent.inbox))}</small>` : ''
  const name = `${esc(agentTitle(agent))}${agent.name ? `<span class="agent-name">@${esc(agent.name)}</span>` : ''}`
  const title = `${agentTitle(agent)} · ${agent.name ? `@${agent.name} · ` : ''}${agent.pane} — ${t('sidebar.rowHint')}`
  return rowHtml({ pane: agent.pane, lead: dotHtml(agent) + kindMarkHtml(agent.kind), name, sub, right, title })
}

function terminalRow(term) {
  const name = esc(terminalLabel(term, state.home))
  return rowHtml({ pane: term.pane, lead: icon('term'), name, title: term.pane, terminalRow: true })
}

function branchHtml(branch) {
  if (!branch) return ''
  const ahead = branch.ahead ? ` <span class="diff-add">↑${branch.ahead}</span>` : ''
  const behind = branch.behind ? ` <span class="diff-del">↓${branch.behind}</span>` : ''
  return `<span class="ws-branch">${esc(branch.name)}${ahead}${behind}</span>`
}

function groupHtml(workspace, agents, terminals) {
  const holdsSelection = [...agents, ...terminals].some(x => x.pane === state.selected)
  const collapsed = state.collapsed.has(workspace.id) && !holdsSelection
  const hot = collapsed ? pickHottest(agents) : null
  const branch = agents.find(a => a.branch)?.branch
  const head = `<div class="ws-head" data-workspace="${esc(workspace.id)}">
    <button type="button" class="ws-toggle" data-action="toggle-group" data-workspace="${esc(workspace.id)}" aria-expanded="${!collapsed}"><span class="ws-chevron">${icon('right')}</span>${hot ? dotHtml(hot) : ''}<span class="ws-name">${esc(workspace.label)}</span>${branchHtml(branch)}</button>
    <button type="button" class="icon-btn icon-btn-xs ws-add" data-action="new-in" data-workspace="${esc(workspace.id)}" aria-label="${esc(t('sidebar.newIn', { name: workspace.label }))}" title="${esc(t('sidebar.newIn', { name: workspace.label }))}">${icon('plus')}</button>
  </div>`
  const rows = collapsed ? '' : agents.map(a => agentRow(a, false)).join('') + terminals.map(terminalRow).join('')
  return `<div class="ws-group" role="group" aria-label="${esc(workspace.label)}">${head}${rows}</div>`
}

/**
 * The workspaces the list shows: every one herdr has (but those hidden by configuration), so one with no agent,
 * or only plain terminals while they are hidden, still has its header and its `+`.
 */
const shownWorkspaces = () => state.workspaces

function renderGroupsToggle() {
  const button = $('#toggle-groups')
  const shown = shownWorkspaces().map(w => w.id)
  button.hidden = state.needsOnly || !shown.length
  const anyOpen = shown.some(id => !state.collapsed.has(id))
  const label = t(anyOpen ? 'sidebar.collapseAll' : 'sidebar.expandAll')
  button.setAttribute('aria-label', label)
  button.title = label
  button.querySelector('use')?.setAttribute('href', anyOpen ? '#i-collapse-all' : '#i-expand-all')
}

export function renderSidebar() {
  const box = $('#thread-list')
  const scroll = box.scrollTop
  $('#nav-needs').setAttribute('aria-pressed', String(state.needsOnly))
  $('#nav-new').classList.toggle('is-active', !state.selected)
  $('#list-title').textContent = state.needsOnly ? t('sidebar.needsYou') : t('sidebar.sessions')
  $('#toggle-terminals').setAttribute('aria-pressed', String(state.showTerminals))
  renderGroupsToggle()
  let html = ''
  if (state.needsOnly) {
    html = needList(state.agents)
      .map(a => agentRow(a, true))
      .join('')
    if (!html) html = `<div class="empty-list">${esc(t('sidebar.nothingWaiting'))}</div>`
  } else {
    for (const workspace of shownWorkspaces()) {
      const agents = state.agents.filter(a => a.workspace === workspace.id).sort(byPane)
      const terminals = state.showTerminals ? state.terminals.filter(x => x.workspace === workspace.id) : []
      html += groupHtml(workspace, agents, terminals)
    }
    if (!html) html = `<div class="empty-list">${esc(t('sidebar.empty'))}</div>`
  }
  if (html === renderedHtml) return
  const focusKey = focusedKey(box)
  renderedHtml = html
  box.innerHTML = html
  refreshTimes(box)
  box.scrollTop = scroll
  if (focusKey) box.querySelector(focusKey)?.focus()
}

// State pushes re-render the list every second or so; keep keyboard focus on the same control.
function focusedKey(box) {
  const el = document.activeElement
  if (!el || !box.contains(el) || !el.dataset.action) return null
  const pane = el.closest('[data-pane]')?.dataset.pane
  const workspace = el.dataset.workspace
  const scope = pane ? `[data-pane="${CSS.escape(pane)}"] ` : ''
  const ws = workspace ? `[data-workspace="${CSS.escape(workspace)}"]` : ''
  return `${scope}[data-action="${el.dataset.action}"]${ws}`
}

const isDrawerOpen = () => $('#app').classList.contains('is-drawer-open')

function openDrawer() {
  if (isNarrow()) {
    $('#app').classList.add('is-drawer-open')
    $('#scrim').hidden = false
    document.activeElement?.blur?.()
  } else setSidebarHidden(false)
}

/** The one-tap way to what needs you: the drawer (or sidebar), filtered to the inbox. */
export function openNeeds() {
  state.needsOnly = true
  renderSidebar()
  openDrawer()
  $('#thread-list').scrollTop = 0
}

export function closeDrawer() {
  const app = $('#app')
  if (!app.classList.contains('is-drawer-open')) return false
  app.classList.remove('is-drawer-open')
  $('#scrim').hidden = true
  return true
}

function setSidebarHidden(hidden) {
  state.sidebarHidden = hidden
  save('sidebarHidden', hidden)
  $('#app').classList.toggle('is-sidebar-hidden', hidden)
  setTimeout(() => terminal.refit(), 60)
}

export function toggleSidebar() {
  if (isNarrow()) {
    if (!closeDrawer()) openDrawer()
  } else setSidebarHidden(!state.sidebarHidden)
}

/** A new session in this workspace, in its folder. */
function newIn(id) {
  const workspace = workspaceBy(id)
  if (!workspace) return
  if (workspace.cwd) setHomeDir(workspace.cwd)
  state.homeWorkspace = id
  goHome()
}

async function renameWorkspace(id) {
  const workspace = workspaceBy(id)
  if (!workspace) return
  const label = await promptDialog({
    title: t('workspace.rename'),
    label: t('workspace.nameLabel'),
    value: workspace.label,
    validate: v => (WORKSPACE_LABEL_RE.test(v) ? null : t('workspace.nameInvalid')),
  })
  if (label == null || label === workspace.label) return
  await postAction({ op: 'renameWorkspace', workspace: id, label }, t('toast.workspaceRenamed', { name: label }))
}

function openWorkspaceMenu(anchor, id) {
  const workspace = workspaceBy(id)
  if (!workspace) return
  openMenu(anchor, [
    { header: workspace.label },
    { label: t('workspace.rename'), icon: 'file', run: () => renameWorkspace(id) },
  ])
}

export function initSidebar() {
  $('#app').classList.toggle('is-sidebar-hidden', state.sidebarHidden)
  const list = $('#thread-list')
  list.addEventListener('click', e => {
    const target = e.target.closest('[data-action]')
    if (!target) return
    const action = target.dataset.action
    if (action === 'new-in') return newIn(target.dataset.workspace)
    if (action === 'toggle-group') {
      const id = target.dataset.workspace
      if (state.collapsed.has(id)) state.collapsed.delete(id)
      else state.collapsed.add(id)
      save('collapsed', [...state.collapsed])
      return renderSidebar()
    }
    const pane = target.closest('[data-pane]')?.dataset.pane
    if (!pane) return
    if (action === 'open') selectPane(pane)
    else if (action === 'pane-menu') openPaneMenu(target, pane)
  })
  onLongPress(list, '[data-pane]', (row, point) => openPaneMenu(point, row.dataset.pane))
  onLongPress(list, '.ws-head', (head, point) => openWorkspaceMenu(point, head.dataset.workspace))
  list.addEventListener('contextmenu', e => {
    const head = e.target.closest('.ws-head')
    const row = e.target.closest('[data-pane]')
    if (!head && !row) return
    e.preventDefault()
    const point = { x: e.clientX, y: e.clientY }
    if (head) openWorkspaceMenu(point, head.dataset.workspace)
    else openPaneMenu(point, row.dataset.pane)
  })
  $('#nav-needs').addEventListener('click', () => {
    state.needsOnly = !state.needsOnly
    renderSidebar()
  })
  $('#nav-new').addEventListener('click', () => goHome())
  $('#nav-search').addEventListener('click', () => openPalette())
  $('#toggle-groups').addEventListener('click', () => {
    state.collapsed = toggleAllGroups(
      state.collapsed,
      shownWorkspaces().map(w => w.id),
    )
    save('collapsed', [...state.collapsed])
    renderSidebar()
  })
  $('#toggle-terminals').addEventListener('click', () => {
    state.showTerminals = !state.showTerminals
    save('showTerminals', state.showTerminals)
    renderSidebar()
  })
  $('#sidebar-hide').addEventListener('click', () => setSidebarHidden(true))
  document.addEventListener('click', e => {
    if (e.target.closest('[data-open-sidebar]')) openDrawer()
    else if (e.target.closest('[data-open-needs]')) openNeeds()
  })
  $('#scrim').addEventListener('click', () => closeDrawer())
  initDrawerSwipe({
    drawer: $('#sidebar'),
    isEnabled: () => isNarrow() && $('#palette').hidden && !document.querySelector('dialog[open]') && $('#menu').hidden,
    isOpen: isDrawerOpen,
    open: openDrawer,
    close: closeDrawer,
  })
}
