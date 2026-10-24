import { defineAction, id, requireAgent } from './context.ts'
import { integer, object, optional } from './validate.ts'

const DEFAULT_SNOOZE_MINUTES = 30
const MAX_SNOOZE_MINUTES = 7 * 24 * 60

export const ack = defineAction(object({ pane: id }), {
  refresh: true,
  async run(ctx, p) {
    ctx.inbox.ack(requireAgent(ctx, p.pane))
    return undefined
  },
})

/**
 * The user looked at a finished reply. A blocked agent still needs an answer, so it stays in the inbox. herdr
 * has no way to mark a pane seen but showing it: a pane herdr calls done is focused there, so herdr follows
 * what was read here, and its `done` clears as the web's does.
 */
export const seen = defineAction(object({ pane: id }), {
  refresh: true,
  async run(ctx, p) {
    const agent = requireAgent(ctx, p.pane)
    if (agent.agent_status === 'blocked') return undefined
    ctx.inbox.ack(agent)
    if (agent.agent_status === 'done') await ctx.herdr.focusAgent(p.pane)
    return undefined
  },
})

export const unack = defineAction(object({ pane: id }), {
  refresh: true,
  async run(ctx, p) {
    requireAgent(ctx, p.pane)
    ctx.inbox.unack(p.pane)
    return undefined
  },
})

export const snooze = defineAction(object({ pane: id, minutes: optional(integer(1, MAX_SNOOZE_MINUTES)) }), {
  refresh: true,
  async run(ctx, p) {
    ctx.inbox.snooze(requireAgent(ctx, p.pane), p.minutes ?? DEFAULT_SNOOZE_MINUTES)
    return undefined
  },
})

/** Drop a first message that failed or expired; the pane may not run an agent (any more). */
export const dismissFirstMessage = defineAction(object({ pane: id }), {
  refresh: true,
  async run(ctx, p) {
    ctx.firstMessages.dismiss(p.pane)
    return undefined
  },
})
