import { isUnansweredTurn } from '../agents/thread.ts'
import type { Agent } from '../herdr.ts'
import { UserError } from '../server/http.ts'
import { HeldError } from '../server/reply-queue.ts'
import { TuiError } from '../tui/index.ts'
import {
  type ActionContext,
  conversationOf,
  defineAction,
  id,
  requireAgent,
  requirePane,
  transcriptOf,
} from './context.ts'
import { arrayOf, object, optional, string } from './validate.ts'

// herdr send-keys names (`esc`, `shift+right`, `ctrl+u`, `f5`) or one printable character. Never a leading `-`:
// herdr's argv parser would read it as an option and it has no `--`.
export const KEY = /^(?:[a-z0-9]+(?:\+[a-z0-9]+)*|[!-,./:-~])$/i

/** Two reads of a draft are the same text when only whitespace differs (the TUI may re-wrap it). */
export const sameDraft = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

/**
 * Type a reply into the agent's input box and submit it. herdr types at the cursor, so text left in the box
 * (typed in the terminal, maybe with the cursor moved into it) would be spliced around the reply: such a draft
 * stops the send (`terminal_draft`) unless the browser approved discarding exactly that text. Someone may
 * keep typing in the terminal while the browser asks, so a draft that is not the one approved stops the send
 * again, with the text now in the box.
 */
export const reply = defineAction(
  object({
    pane: id,
    text: string({ max: 100_000, trim: true }),
    discardDraft: optional(string({ max: 100_000 })),
  }),
  {
    serial: true,
    async run(ctx, p) {
      const agent = requireAgent(ctx, p.pane)
      if (!p.text) throw new UserError('empty_text', 'The reply is empty')
      if (agent.agent_status === 'blocked') await ctx.tui.prepareReply(p.pane)
      // A panel left open (`/config`) would swallow the text: close it, unless that would stop a working turn.
      await ctx.tui.showInputBox(p.pane, { escape: agent.agent_status !== 'working' })
      const draft = await ctx.tui.inputDraft(p.pane)
      if (draft && p.discardDraft === undefined)
        throw new TuiError('terminal_draft', 'The terminal input holds text that was not sent', { draft })
      if (draft && !sameDraft(draft, p.discardDraft ?? ''))
        throw new TuiError('terminal_draft', 'The terminal input changed since it was shown', { draft })
      if (draft) await ctx.tui.discardDraft(p.pane)
      await ctx.herdr.prompt(p.pane, p.text)
      // "Send again" on a failed first message is a plain reply; once it went through, the card has done its job.
      ctx.firstMessages.dismiss(p.pane)
      ctx.inbox.invalidate(p.pane)
      return undefined
    },
  },
)

/**
 * Queue a message for when the agent's turn ends (`ReplyQueues` sends it). For both agents alike: Claude Code
 * has no such queue of its own, and Codex's (Tab) could not be shown or edited from here.
 */
export const queueReply = defineAction(object({ pane: id, text: string({ max: 100_000, trim: true }) }), {
  refresh: true,
  async run(ctx, p) {
    const agent = requireAgent(ctx, p.pane)
    if (!p.text) throw new UserError('empty_text', 'The message is empty')
    const conversation = await conversationOf(ctx, agent).catch(() => null)
    try {
      return { id: ctx.replyQueues.add(p.pane, conversation, p.text) }
    } catch (err) {
      throw new UserError('queue_full', err instanceof Error ? err.message : String(err), 409)
    }
  },
})

/** Take a message out of the queue (deleted, or back in the composer). `sent` when it went out meanwhile. */
export const unqueueReply = defineAction(object({ pane: id, id: string({ max: 64 }) }), {
  refresh: true,
  async run(ctx, p) {
    return ctx.replyQueues.remove(p.pane, p.id) ? undefined : { sent: true }
  },
})

/** Go on sending a queue a web interrupt or a failed send paused. */
export const resumeQueue = defineAction(object({ pane: id }), {
  refresh: true,
  async run(ctx, p) {
    ctx.replyQueues.resume(p.pane)
    return undefined
  },
})

/**
 * Type a queued message once the turn ended, under the rules of a reply, except that nothing in the terminal is
 * closed or discarded: text typed there holds the queue until it is gone.
 */
export function sendQueued(ctx: ActionContext, pane: string, text: string, wanted: () => boolean): Promise<boolean> {
  return ctx.locks.run(pane, async () => {
    await ctx.tui.showInputBox(pane, { escape: false })
    if (await ctx.tui.inputDraft(pane)) throw new HeldError('terminal_draft')
    if (!wanted()) return false
    await ctx.herdr.prompt(pane, text)
    ctx.inbox.invalidate(pane)
    return true
  })
}

/** The browser left a panel command's terminal: the panel closes too, so what is sent next reaches the input box. */
export const closePanel = defineAction(object({ pane: id }), {
  serial: true,
  async run(ctx, p) {
    const agent = requireAgent(ctx, p.pane)
    await ctx.tui.showInputBox(p.pane, { escape: agent.agent_status !== 'working' })
    ctx.inbox.invalidate(p.pane)
    return undefined
  },
})

/**
 * Shift+Tab in the agent's input box: its next mode (Claude Code's permission modes, Codex's collaboration
 * modes). In a dialog or panel the key means something else, so the input box must be on screen; nothing is
 * closed to get there.
 */
export const cycleMode = defineAction(object({ pane: id }), {
  serial: true,
  async run(ctx, p) {
    requireAgent(ctx, p.pane)
    await ctx.tui.showInputBox(p.pane, { escape: false })
    await ctx.herdr.sendKeys(p.pane, ['shift+tab'])
    ctx.inbox.invalidate(p.pane)
    return undefined
  },
})

/** How long a clear-goal waits for the interrupted agent to stop before giving up. */
const STOP_TIMEOUT_MS = 15_000

/**
 * Interrupt the turn. `restored` tells the web composer to give `last` (what it sent) back, the same way
 * for both agents: when the interrupted turn had produced nothing yet. Claude Code then puts the prompt
 * back into its own input box, which is cleared so the TUI and the web UI do not both hold it. Codex never
 * does, so its rollout decides.
 */
async function stopTurn(ctx: ActionContext, agent: Agent, last: string): Promise<{ restored: true } | undefined> {
  if (agent.agent !== 'codex') {
    const { restored } = await ctx.tui.interruptAndRestore(agent.pane_id, last)
    return restored ? { restored } : undefined
  }
  await ctx.tui.interrupt(agent.pane_id)
  if (!last) return undefined
  const path = await transcriptOf(ctx, agent).catch(() => null)
  return path && isUnansweredTurn(ctx.agents.lastTurn('codex', path), last) ? { restored: true } : undefined
}

const lastSent = optional(string({ max: 100_000 }))

export const interrupt = defineAction(object({ pane: id, last: lastSent }), {
  serial: true,
  async run(ctx, p) {
    // Stopping the turn is no go-ahead for what was queued behind it.
    ctx.replyQueues.pause(p.pane)
    return stopTurn(ctx, requireAgent(ctx, p.pane), p.last ?? '')
  },
})

/**
 * `/goal clear`. Typed while the agent works, Claude Code queues it behind a goal that never ends and Codex
 * ignores it, so a working agent is interrupted first and the command is typed once it stopped.
 */
export const clearGoal = defineAction(object({ pane: id, last: lastSent }), {
  serial: true,
  async run(ctx, p) {
    const agent = requireAgent(ctx, p.pane)
    let result: { restored: true } | undefined
    if (agent.agent_status === 'working') {
      result = await stopTurn(ctx, agent, p.last ?? '')
      if (!(await ctx.herdr.waitAgent(p.pane, ['idle', 'done'], STOP_TIMEOUT_MS)))
        throw new UserError('still_working', 'The agent did not stop, so the goal was not cleared', 409)
      await ctx.tui.clearInput(p.pane)
    } else if (agent.agent_status === 'blocked') await ctx.tui.prepareReply(p.pane)
    await ctx.herdr.prompt(p.pane, '/goal clear')
    ctx.inbox.invalidate(p.pane)
    return result
  },
})

/** Raw keys; also allowed on plain terminal panes. */
export const keys = defineAction(
  object({ pane: id, keys: arrayOf(string({ max: 32, pattern: KEY }), { min: 1, max: 64 }) }),
  {
    serial: true,
    async run(ctx, p) {
      requirePane(ctx, p.pane)
      await ctx.herdr.sendKeys(p.pane, p.keys)
      if (ctx.hub.agent(p.pane)) ctx.inbox.invalidate(p.pane)
      return undefined
    },
  },
)
