import type { Agent, Pane, Snapshot } from '../../src/herdr.ts'
import type { AgentView } from '../../src/protocol.ts'

// A synthetic herdr snapshot: workspace w1 "app" (an agent and a shell), w2 "Board" (an agent).
export function fakeSnapshot(): Snapshot {
  const pane = (pane_id: string, tab_id: string, workspace_id: string, extra: Partial<Pane> = {}): Pane => ({
    pane_id,
    tab_id,
    workspace_id,
    cwd: '/home/alice/project',
    ...extra,
  })
  const agent = (p: Pane, kind: string, status: Agent['agent_status']): Agent => ({
    ...p,
    agent: kind,
    agent_status: status,
    agent_session: { value: '00000000-0000-4000-8000-000000000001' },
  })
  const p1 = pane('w1:p1', 'w1:t1', 'w1', { foreground_cwd: '/home/alice/project/sub' })
  const p2 = pane('w1:p2', 'w1:t1', 'w1', { label: '  build  ' })
  const p3 = pane('w2:p1', 'w2:t1', 'w2')
  const p4 = pane('w2:p2', 'w2:t1', 'w2')
  return {
    workspaces: [
      { workspace_id: 'w1', label: 'app', number: 1, agent_status: 'idle' },
      { workspace_id: 'w2', label: 'Board', number: 2, agent_status: 'idle' },
    ],
    tabs: [
      { tab_id: 'w1:t1', workspace_id: 'w1', label: 'main', number: 1 },
      { tab_id: 'w2:t1', workspace_id: 'w2', label: 'board', number: 1 },
    ],
    panes: [p1, p2, p3, p4],
    agents: [agent(p1, 'claude', 'working'), agent(p3, 'codex', 'blocked')],
    layouts: [],
  }
}

/** Run `fn` with console.error silenced, for code paths that log an expected failure. */
export async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const error = console.error
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.error = error
  }
}

export function fakeView(pane: string, workspace: string, status: AgentView['status']): AgentView {
  return {
    pane,
    tab: `${workspace}:t1`,
    workspace,
    workspaceLabel: workspace,
    tabLabel: 'main',
    kind: 'claude',
    name: null,
    title: '',
    cwd: '/home/alice/project',
    status,
    since: 0,
    branch: null,
    session: null,
    activity: null,
    ctx: null,
    mode: null,
    effort: null,
    ultra: false,
    model: null,
    asks: 0,
    shells: 0,
    inbox: null,
  }
}
