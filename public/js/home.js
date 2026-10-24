import { postAction } from './api.js'
import { attachmentItems, onAttachmentsChange, renderAttachments, uploadingCount } from './attachments.js'
import { modelCatalog } from './catalogs.js'
import { isSendKey } from './composer.js'
import { promptDialog } from './dialog.js'
import { homeDir, initDirPicker, loadDirChoices, openDirPicker, rememberDir } from './dirs.js'
import { $, autosize, esc, icon } from './dom.js'
import { elidePath, embedAttachments, shortCwd } from './format.js'
import { t } from './i18n/index.js'
import { DOUBLE_CLICK_MS, inflight, requestId } from './inflight.js'
import { openMenu } from './menus.js'
import { WORKSPACE_LABEL_RE, folderLabel, homeTarget, kindLabel, resolveModelPick } from './model.js'
import { toast } from './notify.js'
import { state, workspaceBy } from './state.js'
import { load, save } from './storage.js'

const HOME_AGENTS = ['claude', 'codex', 'shell']

const homeAgentLabel = agent => (agent === 'shell' ? t('home.terminal') : kindLabel(agent))

/** What a new session can run, for the home screen and the tab bar's "+" menu. */
export const newSessionKinds = () =>
  HOME_AGENTS.map(kind => ({ kind, label: homeAgentLabel(kind), icon: kind === 'shell' ? 'term' : 'cpu' }))
const pickFor = kind => load(`homeModel:${kind}`, {})

let resolved = null

/** Where a new session goes now: an existing workspace, or a new one and its name. */
export function currentTarget() {
  return homeTarget({
    dir: homeDir(),
    pick: state.homeWorkspace,
    newName: state.homeNewName,
    workspaces: state.workspaces,
    panes: [...state.agents, ...state.terminals],
  })
}

export function renderHome() {
  renderDirChip()
  renderWorkspaceChip()
  $('#home-agent .chip-label').textContent = homeAgentLabel(state.homeAgent)
  renderShellNote()
  renderHomeModel()
}

let requestedDirs = false

// Which folder the session starts in decides which repository the agent edits: always on show.
function renderDirChip() {
  if (!requestedDirs) {
    requestedDirs = true
    // Until a folder is picked, the default is the most recent one, known once this answers.
    loadDirChoices().then(() => !state.homeDir && renderHome())
  }
  const dir = homeDir()
  $('#home-dir .chip-label').textContent = elidePath(shortCwd(dir, state.home))
  $('#home-dir').title = t('dir.startsIn', { dir })
}

// The workspace follows the folder: the one already working there, else a new one named after it.
function renderWorkspaceChip() {
  const target = currentTarget()
  const chip = $('#home-workspace')
  const label = $('#home-workspace .chip-label')
  if ('newWorkspace' in target) {
    label.textContent = t('home.newWorkspaceChip', { name: target.newWorkspace })
    chip.title = t('home.newWorkspaceTitle', { name: target.newWorkspace })
    return
  }
  const workspace = workspaceBy(target.workspace)
  label.textContent = workspace ? `${workspace.label}${workspace.busy ? '' : ` · ${t('home.idle')}`}` : ''
  chip.title = t('home.workspaceHeader')
}

// A plain terminal has nobody to read a first message: the field is kept (and what it holds) but switched off.
function renderShellNote() {
  const shell = state.homeAgent === 'shell'
  const textarea = $('#home-text')
  textarea.disabled = shell
  textarea.placeholder = shell ? '' : t('home.placeholder')
  $('#home-form [data-attach="home"]').disabled = shell
  $('#home-shell-note').hidden = !shell
  $('#suggestions').hidden = shell
}

async function renderHomeModel() {
  const kind = state.homeAgent
  const show = kind !== 'shell'
  $('#home-model').hidden = !show
  $('#home-effort').hidden = !show
  if (!show) return
  const catalog = await modelCatalog(kind)
  if (state.homeAgent !== kind) return
  resolved = { kind, catalog, ...resolveModelPick(catalog, pickFor(kind)) }
  $('#home-model').innerHTML =
    `<span class="chip-text">${esc(resolved.model?.label ?? t('composer.model'))}</span>${icon('down')}`
  $('#home-effort').innerHTML =
    `${icon('bolt')}<span class="chip-text">${esc(resolved.effort || t('composer.effort'))}</span>${icon('down')}`
}

function remember(kind, change) {
  save(`homeModel:${kind}`, { ...pickFor(kind), ...change })
  renderHomeModel()
}

function openModelMenu(anchor) {
  if (!resolved) return
  const { kind, catalog, model } = resolved
  openMenu(anchor, [
    { header: t('home.modelHeader') },
    catalog.unavailable && { note: t('model.noCatalog') },
    ...catalog.models.map(m => ({
      label: m.label,
      checked: m === model,
      hint: m.id === catalog.default.model ? t('model.default') : '',
      run: () => remember(kind, { model: m.id }),
    })),
  ])
}

function openEffortMenu(anchor) {
  if (!resolved) return
  const { kind, efforts, effort, defaultEffort } = resolved
  openMenu(anchor, [
    { header: t('home.effortHeader') },
    ...efforts.map(value => ({
      label: value,
      checked: value === effort,
      hint: value === defaultEffort ? t('model.default') : '',
      run: () => remember(kind, { effort: value }),
    })),
  ])
}

async function askNewWorkspace() {
  const target = currentTarget()
  const name = await promptDialog({
    title: t('home.newWorkspaceDialog'),
    label: t('workspace.nameLabel'),
    value: 'newWorkspace' in target ? target.newWorkspace : folderLabel(homeDir()),
    validate: v => (WORKSPACE_LABEL_RE.test(v) ? null : t('workspace.nameInvalid')),
  })
  if (name == null) return
  state.homeWorkspace = null
  state.homeNewName = name.trim()
  renderHome()
}

function openWorkspaceMenu(anchor) {
  const target = currentTarget()
  const picked = 'workspace' in target ? target.workspace : null
  openMenu(anchor, [
    { header: t('home.workspaceHeader') },
    {
      label: t('home.newWorkspace'),
      icon: 'plus',
      hint: 'newWorkspace' in target ? target.newWorkspace : '',
      checked: !picked,
      run: askNewWorkspace,
    },
    { separator: true },
    ...state.workspaces.map(w => ({
      label: w.label,
      icon: 'folder',
      hint: w.busy ? t('home.agentsRunning', { n: w.agents }) : t('home.idle'),
      hintTone: w.busy ? undefined : 'good',
      checked: w.id === picked,
      run: () => {
        state.homeWorkspace = w.id
        state.homeNewName = null
        renderHome()
      },
    })),
  ])
}

function openAgentMenu(anchor) {
  openMenu(anchor, [
    { header: t('home.agentHeader') },
    ...newSessionKinds().map(({ kind, label, icon }) => ({
      label,
      icon,
      checked: state.homeAgent === kind,
      run: () => {
        state.homeAgent = kind
        save('homeAgent', kind)
        renderHome()
      },
    })),
  ])
}

function insertText(textarea, text) {
  if (textarea.disabled) return
  textarea.value = textarea.value ? `${textarea.value.replace(/\s*$/, '')}\n\n${text}` : text
  textarea.focus()
  textarea.dispatchEvent(new Event('input'))
  autosize(textarea)
}

// Start stays off while an upload or the creation itself is still out.
function syncSendButton() {
  const button = $('#home-form .send-btn')
  const creating = inflight.busy('new')
  button.disabled = creating || uploadingCount('home') > 0
  button.setAttribute('aria-busy', String(creating))
}

function submit() {
  if (uploadingCount('home')) return toast(t('composer.waitingForUploadShort'))
  const pending = inflight.run('new', create, DOUBLE_CLICK_MS)
  syncSendButton()
  pending.finally(() => setTimeout(syncSendButton, DOUBLE_CLICK_MS))
}

async function create() {
  const target = currentTarget()
  const cwd = homeDir()
  const textarea = $('#home-text')
  const agent = state.homeAgent === 'shell' ? null : state.homeAgent
  const text = agent ? embedAttachments(textarea.value, attachmentItems('home')) : ''
  const choice = agent && resolved?.kind === agent ? resolved : null
  const result = await postAction({
    op: 'new',
    ...('workspace' in target ? { workspace: target.workspace } : { newWorkspace: target.newWorkspace }),
    cwd,
    ...(agent ? { agent } : {}),
    ...(text ? { text } : {}),
    ...(choice?.modelId ? { model: choice.modelId } : {}),
    ...(choice?.pickedEffort ? { effort: choice.pickedEffort } : {}),
    request: requestId(),
  })
  if (!result?.pane) return
  rememberDir(cwd)
  // Made once: the next session in this folder joins it (it is found from the folder).
  state.homeNewName = null
  if (agent) {
    textarea.value = ''
    autosize(textarea)
    state.attachments.home = []
    renderAttachments('home')
  }
  state.pendingSelect = { pane: result.pane, agent: !!agent, at: Date.now() }
  if (agent && text) state.pendingMessage = { pane: result.pane, text, total: 0, at: Date.now(), starting: agent }
  const where = `${shortCwd(cwd, state.home)} · ${homeAgentLabel(state.homeAgent)}`
  toast(t('toast.started'), agent && text ? t('toast.firstMessageQueued') : where)
}

export function initHome() {
  const textarea = $('#home-text')
  textarea.addEventListener('input', () => autosize(textarea))
  textarea.addEventListener('keydown', e => {
    if (isSendKey(e)) {
      e.preventDefault()
      $('#home-form').requestSubmit()
    }
  })
  $('#home-form').addEventListener('submit', e => {
    e.preventDefault()
    submit()
  })
  $('#home-model').addEventListener('click', e => openModelMenu(e.currentTarget))
  $('#home-effort').addEventListener('click', e => openEffortMenu(e.currentTarget))
  $('#home-workspace').addEventListener('click', e => openWorkspaceMenu(e.currentTarget))
  $('#home-agent').addEventListener('click', e => openAgentMenu(e.currentTarget))
  $('#home-dir').addEventListener('click', e => openDirPicker(e.currentTarget))
  initDirPicker({ onPick: renderHome })
  onAttachmentsChange(which => {
    if (which === 'home') syncSendButton()
  })
  $('#suggestions').addEventListener('click', e => {
    const card = e.target.closest('[data-insert]')
    if (card) insertText(textarea, card.dataset.insert)
  })
}
