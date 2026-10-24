import { type Snapshot, paneCwd } from '../herdr.ts'
import type { AgentView, FirstMessage, ReplyQueue, StatePayload } from '../protocol.ts'

export interface PayloadOptions {
  /** Workspace labels hidden from the sidebar (`HERDR_WEB_HIDE_WORKSPACES`). */
  hidden: ReadonlySet<string>
  home: string
  version: string
}

/**
 * Project a herdr snapshot and the inbox views into what /ws/state sends. Hidden workspaces drop out of
 * the tabs, terminals and workspace list; their agents stay, so they still reach the inbox.
 */
export function toStatePayload(
  snap: Snapshot,
  views: AgentView[],
  opts: PayloadOptions,
  firstMessages: FirstMessage[] = [],
  replyQueues: ReplyQueue[] = [],
): StatePayload {
  const hiddenIds = new Set(snap.workspaces.filter(w => opts.hidden.has(w.label)).map(w => w.workspace_id))
  const agentPanes = new Set(snap.agents.map(a => a.pane_id))
  const firstCwd = new Map<string, string>()
  const tabPanes = new Map<string, string[]>()
  for (const p of snap.panes) {
    if (!firstCwd.has(p.workspace_id)) firstCwd.set(p.workspace_id, paneCwd(p))
    const list = tabPanes.get(p.tab_id)
    if (list) list.push(p.pane_id)
    else tabPanes.set(p.tab_id, [p.pane_id])
  }
  return {
    type: 'state',
    version: opts.version,
    home: opts.home,
    tabs: snap.tabs
      .filter(t => !hiddenIds.has(t.workspace_id))
      .map(t => ({
        id: t.tab_id,
        workspace: t.workspace_id,
        label: t.label,
        number: t.number,
        panes: tabPanes.get(t.tab_id) ?? [],
      })),
    agents: views,
    terminals: snap.panes
      .filter(p => !agentPanes.has(p.pane_id) && !hiddenIds.has(p.workspace_id))
      .map(p => ({
        pane: p.pane_id,
        workspace: p.workspace_id,
        tab: p.tab_id,
        cwd: paneCwd(p),
        title: (p.label || p.terminal_title_stripped || '').trim(),
      })),
    workspaces: snap.workspaces
      .filter(w => !hiddenIds.has(w.workspace_id))
      .map(w => {
        const mine = views.filter(v => v.workspace === w.workspace_id)
        return {
          id: w.workspace_id,
          label: w.label,
          number: w.number,
          cwd: firstCwd.get(w.workspace_id) ?? '',
          busy: mine.some(v => v.status === 'working' || v.status === 'blocked'),
          agents: mine.length,
        }
      }),
    layouts: snap.layouts,
    firstMessages,
    replyQueues,
  }
}
