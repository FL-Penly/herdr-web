import { getJson, postAction } from './api.js'
import { interrupt } from './composer.js'
import { promptDialog } from './dialog.js'
import { $, copyText, isNarrow } from './dom.js'
import { relativeTime, shortCwd } from './format.js'
import { kbd, t } from './i18n/index.js'
import { DOUBLE_CLICK_MS, inflight, requestId } from './inflight.js'
import { openMenu } from './menus.js'
import { AGENT_NAME_RE, agentTitle, kindLabel } from './model.js'
import { toast } from './notify.js'
import { setReviewOpen } from './review.js'
import { agentBy, selectedAgent, state, terminalBy } from './state.js'
import { loadThread } from './thread.js'

// One fork of a pane at a time: alt+F twice, or a second menu pick while copying, would fork twice.
export function forkSession(mode, at) {
  const pane = state.selected
  if (inflight.busy(`fork:${pane}`)) return toast(t('toast.forkPending'))
  return inflight.run(
    `fork:${pane}`,
    async () => {
      toast(t('toast.forking'))
      const result = await postAction({ op: 'fork', pane, mode, ...(at ? { at } : {}), request: requestId() })
      if (result?.pane) {
        state.pendingSelect = { pane: result.pane, agent: true, at: Date.now() }
        toast(t('toast.forked'), t('toast.forkedBody'))
      }
    },
    DOUBLE_CLICK_MS,
  )
}

async function copyWithToast(text, title, body = text) {
  if (await copyText(text)) toast(title, body)
  else toast(t('toast.copyFailed'), '', 'error')
}

async function renameAgent(pane, current) {
  const name = await promptDialog({
    title: current ? t('rename.titleRename') : t('rename.titleName'),
    label: t('rename.label'),
    hint: t('rename.hint'),
    value: current ?? '',
    validate: v => (v && !AGENT_NAME_RE.test(v) ? t('rename.invalid') : null),
  })
  if (name == null || name === (current ?? '')) return
  const ok = await postAction({ op: 'rename', pane, name }, name ? t('toast.named', { name }) : t('toast.nameCleared'))
  if (ok && name) toast(t('toast.nameUsable'), name)
}

function paneMenuItems(pane) {
  const agent = agentBy(pane)
  const term = terminalBy(pane)
  if (!agent && !term) return []
  const target = agent?.name || pane
  const cwd = shortCwd(agent?.cwd ?? term?.cwd, state.home)
  const who = agent ? t('dispatch.who', { kind: kindLabel(agent.kind), title: agentTitle(agent), cwd }) : ''
  const command = `herdr agent prompt ${target} "${t('dispatch.placeholder')}" --wait --timeout 600000`
  return [
    { header: agent?.name ? `${agent.name} · ${pane}` : pane },
    { label: t('pane.copyId'), icon: 'copy', hint: pane, run: () => copyWithToast(pane, t('toast.copied')) },
    agent?.name && {
      label: t('pane.copyName'),
      icon: 'copy',
      hint: agent.name,
      run: () => copyWithToast(agent.name, t('toast.copied')),
    },
    agent && {
      label: t('pane.copyDispatch'),
      icon: 'cmd',
      run: () => copyWithToast(command, t('toast.copiedDispatch'), ''),
    },
    agent && {
      label: t('pane.copyInstructions'),
      icon: 'users',
      run: () =>
        copyWithToast(
          t('dispatch.instructions', { target, who }),
          t('toast.copiedInstructions'),
          t('toast.pasteToAgent'),
        ),
    },
    agent && { separator: true },
    agent && {
      label: agent.name ? t('pane.rename') : t('pane.name'),
      icon: 'file',
      hint: agent.name ? '' : t('pane.nameHint'),
      run: () => renameAgent(pane, agent.name),
    },
    agent?.name && {
      label: t('pane.clearName'),
      icon: 'x',
      run: () => postAction({ op: 'rename', pane, name: '' }, t('toast.nameCleared')),
    },
  ]
}

export function openPaneMenu(anchor, pane) {
  const items = paneMenuItems(pane)
  if (items.length) openMenu(anchor, items)
}

/**
 * Nothing ties a Codex process to its rollout file, so the web guesses and checks the guess against the
 * terminal. When it still shows another conversation, the user says which one: the pane's candidates, the one
 * whose newest message the terminal shows marked.
 * @param {HTMLElement} anchor
 * @param {string} pane
 */
async function syncSession(anchor, pane) {
  /** @type {{ sessions: import('../../src/protocol.ts').CodexSession[] }} */
  let result
  try {
    result = await getJson('/api/sessions', { pane })
  } catch (err) {
    return toast(t('sync.failed'), err instanceof Error ? err.message : String(err), 'error')
  }
  if (pane !== state.selected) return
  const { sessions } = result
  if (!sessions.length) return toast(t('sync.none'))
  const justNow = t('time.justNow')
  openMenu(anchor, [
    { header: t('sync.title') },
    { note: t('sync.note') },
    ...sessions.map(s => ({
      label: s.prompt?.replace(/\s+/g, ' ').trim() || t('sync.noPrompt'),
      hint: [s.onScreen && t('sync.onScreen'), relativeTime(s.at, { justNow })].filter(Boolean).join(' · '),
      hintTone: s.onScreen ? /** @type {const} */ ('good') : undefined,
      checked: s.current,
      run: async () => {
        if (s.current) return
        if (await postAction({ op: 'pinSession', pane, path: s.path }, t('sync.done'))) loadThread(true)
      },
    })),
  ])
}

function openMoreMenu(anchor) {
  const pane = state.selected
  if (!pane) return
  const agent = selectedAgent()
  const diff = state.diff
  openMenu(anchor, [
    agent?.status === 'working' && { label: t('menu.stop'), icon: 'x', run: interrupt },
    isNarrow() &&
      diff?.files.length && {
        label: t('review.toggle'),
        icon: 'eye',
        hint: `+${diff.added} −${diff.removed}`,
        run: () => setReviewOpen(true),
      },
    agent?.inbox && { label: t('menu.markHandled'), icon: 'check', run: () => postAction({ op: 'ack', pane }) },
    agent?.inbox && {
      label: t('menu.snooze'),
      icon: 'bell',
      run: () => postAction({ op: 'snooze', pane, minutes: 60 }, t('toast.snoozed')),
    },
    agent && { header: t('fork.session') },
    agent && { label: t('fork.toTab'), icon: 'fork', hint: kbd('alt+F'), run: () => forkSession('tab') },
    agent && { label: t('fork.toRight'), icon: 'side', run: () => forkSession('right') },
    agent && { label: t('fork.toDown'), icon: 'side', run: () => forkSession('down') },
    { separator: true },
    agent?.kind === 'codex' && { label: t('sync.menu'), icon: 'refresh', run: () => syncSession(anchor, pane) },
    { label: t('menu.focusInHerdr'), icon: 'target', run: () => postAction({ op: 'focus', pane }, t('toast.focused')) },
    ...paneMenuItems(pane).slice(1),
  ])
}

export function initPaneMenus() {
  $('#more-btn').addEventListener('click', e => openMoreMenu(e.currentTarget))
}
