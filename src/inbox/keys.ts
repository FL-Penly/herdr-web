import type { Agent } from '../herdr.ts'

// herdr bumps `completion_seq` when an agent finishes a turn and `state_change_seq` on every status change.

/**
 * What an ack or snooze applies to: this blocked spell (one turn can block several times), or this
 * finished turn. A new one shows again.
 */
export function ackKey(a: Pick<Agent, 'agent_status' | 'completion_seq' | 'state_change_seq'>): string {
  return a.agent_status === 'blocked' ? `b:${a.state_change_seq ?? 0}` : `f:${a.completion_seq ?? 0}`
}

/** When it changes, the agent's "since" timestamp restarts. */
export function sinceKey(a: Pick<Agent, 'agent_status' | 'completion_seq'>): string {
  return `${a.agent_status}:${a.completion_seq ?? 0}`
}

/** When it changes, the cached last reply is read again. */
export function replyKey(a: Pick<Agent, 'agent_status' | 'completion_seq' | 'state_change_seq'>): string {
  return `${a.agent_status}:${a.completion_seq ?? 0}:${a.state_change_seq ?? 0}`
}

/** Who runs in the pane; a change means the pane id was reused and its stored inbox state is stale. */
export function identityKey(a: Pick<Agent, 'agent' | 'agent_session'>): string {
  return `${a.agent}:${a.agent_session?.value ?? ''}`
}
