import type { Action } from '../protocol.ts'
import { UserError } from '../server/http.ts'
import type { ActionContext, ActionDef } from './context.ts'
import { asyncAnswer, option, revealDialog } from './dialog.ts'
import { fork } from './fork.ts'
import { ack, dismissFirstMessage, seen, snooze, unack } from './inbox.ts'
import {
  clearGoal,
  closePanel,
  cycleMode,
  interrupt,
  keys,
  queueReply,
  reply,
  resumeQueue,
  unqueueReply,
} from './reply.ts'
import { closeTab, focus, newSession, pinSession, rename, renameWorkspace } from './session.ts'

export type { ActionContext } from './context.ts'

// Each definition is typed by its own params; the registry only needs "some params".
const registry: Record<Action['op'], ActionDef<any>> = {
  new: newSession,
  rename,
  renameWorkspace,
  closeTab,
  focus,
  reply,
  closePanel,
  cycleMode,
  queueReply,
  unqueueReply,
  resumeQueue,
  pinSession,
  interrupt,
  clearGoal,
  keys,
  option,
  asyncAnswer,
  revealDialog,
  ack,
  seen,
  unack,
  snooze,
  dismissFirstMessage,
  fork,
}

/**
 * Under the pane's lock. Whatever an action types may answer the dialog on screen, and herdr can report the next,
 * identical-looking prompt as the same blocked spell: the inbox hears of it before and after, so no tick in
 * between takes the next prompt for the one answered.
 */
async function runSerial<P>(ctx: ActionContext, action: ActionDef<P>, params: P) {
  const pane = (params as { pane: string }).pane
  const typed = !action.readOnly && ctx.hub.agent(pane) !== null
  if (typed) ctx.inbox.input(pane)
  try {
    return await action.run(ctx, params)
  } finally {
    if (typed) ctx.inbox.input(pane)
  }
}

/** Validate a POST /api/act body, run it, and return the fields to send back after `ok: true`. */
export async function dispatch(ctx: ActionContext, body: unknown): Promise<object> {
  const op = typeof body === 'object' && body !== null ? (body as { op?: unknown }).op : undefined
  if (typeof op !== 'string' || !Object.hasOwn(registry, op))
    throw new UserError('unknown_op', `Unknown op ${JSON.stringify(op ?? null)}`)
  const action = registry[op as Action['op']]
  const params = action.params(body, 'body')
  const execute = async () => {
    const result = action.serial
      ? await ctx.locks.run((params as { pane: string }).pane, () => runSerial(ctx, action, params))
      : await action.run(ctx, params)
    if (action.refresh) await ctx.hub.refresh()
    return result ?? {}
  }
  const request = action.idempotent ? (params as { request?: string }).request : undefined
  // A double click or a retry after a lost response must not open a second tab.
  return request ? ctx.requests.getOrLoad(`${op}:${request}`, execute) : execute()
}
