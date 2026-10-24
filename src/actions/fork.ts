import { ForkError } from '../../plugin/quick-fork/fork.ts'
import type { Agent } from '../herdr.ts'
import { UserError } from '../server/http.ts'
import { type ActionContext, defineAction, id, requestId, requireAgent, transcriptOf } from './context.ts'
import { object, oneOf, optional, string } from './validate.ts'

const CLAUDE_MESSAGE = /^[0-9a-f-]{36}$/i
const CODEX_POINT = /^([^#]+\.jsonl)#\d+$/

/** A fork point from the thread: a Claude message uuid, or `<rollout path>#<byte offset>` inside CODEX_HOME. */
function isValidForkPoint(ctx: ActionContext, kind: string, at: string): boolean {
  if (kind === 'claude') return CLAUDE_MESSAGE.test(at)
  if (kind === 'codex') {
    const path = CODEX_POINT.exec(at)?.[1]
    return !!path && ctx.agents.isCodexRollout(path)
  }
  return false
}

async function codexSession(ctx: ActionContext, agent: Agent): Promise<string | undefined> {
  const path = await transcriptOf(ctx, agent)
  return (path && ctx.agents.codexSessionId(path)) || undefined
}

// herdr failures are ours (502); the other ForkError codes describe the request.
function asUserError(err: unknown): UserError {
  if (err instanceof ForkError) return new UserError(err.code, err.message, err.code === 'herdr' ? 502 : 400)
  return new UserError('fork_failed', err instanceof Error ? err.message : String(err), 500)
}

export const fork = defineAction(
  object({
    pane: id,
    mode: optional(oneOf(['right', 'down', 'tab'])),
    at: optional(string({ max: 4096 })),
    request: optional(requestId),
  }),
  {
    idempotent: true,
    async run(ctx, p) {
      const agent = requireAgent(ctx, p.pane)
      if (p.at !== undefined && !isValidForkPoint(ctx, agent.agent, p.at))
        throw new UserError('invalid_fork_point', 'Not a valid fork point for this agent')
      // A fork from `at` resumes a cut copy that carries its own id, so only a whole-session Codex fork needs one.
      const session = agent.agent === 'codex' && p.at === undefined ? await codexSession(ctx, agent) : undefined
      // No overall timeout: every herdr call inside forkSession has its own, and racing one would not stop it.
      try {
        const made = await ctx.fork({ pane: p.pane, mode: p.mode ?? 'tab', session, at: p.at })
        return { pane: made.pane }
      } catch (err) {
        throw asUserError(err)
      }
    },
  },
)
