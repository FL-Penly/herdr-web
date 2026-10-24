import { shellJoin } from '../../plugin/quick-fork/fork.ts'
import { paneCwd } from '../herdr.ts'
import { expandHome } from '../server/dirs.ts'
import { UserError } from '../server/http.ts'
import { type ActionContext, defineAction, id, requestId, requireAgent } from './context.ts'
import { object, oneOf, optional, string } from './validate.ts'

// Model ids look like `opus`, `claude-opus-4-1[1m]`, `gpt-5.1-codex`; efforts like `high`. They become
// argv, so no leading `-` and nothing a shell would interpret (they are quoted anyway).
const cliToken = string({ max: 60, pattern: /^(?:[\w.[\]:/][\w.[\]:/-]*)?$/ })
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/
// A workspace label goes to herdr as one argv entry: no control characters, nothing that reads as a flag.
const workspaceLabel = string({ max: 64, trim: true, pattern: /^(?:[^\s\-\p{Cc}][^\p{Cc}]*)?$/u })

/** The argv that starts an agent; `text` follows `--` so a message such as `--help` is never a flag. */
export function agentCommand(kind: 'claude' | 'codex', model: string, effort: string, text: string): string[] {
  const cmd =
    kind === 'claude'
      ? ['claude', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])]
      : ['codex', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : [])]
  return text ? [...cmd, '--', text] : cmd
}

/**
 * Whether a first message can go on the command line. Slash commands are not prompts there, and a
 * newline would be typed into the shell as Enter; both are sent once the agent is up instead.
 */
export function rideArgv(text: string): boolean {
  return !text.startsWith('/') && !/[\n\r]/.test(text)
}

function startDir(ctx: ActionContext, workspace: string, cwd: string | undefined): string {
  if (cwd) {
    const dir = expandHome(cwd, ctx.home)
    // herdr would open the tab somewhere else, or fail later with a less useful error.
    if (!ctx.dirs.isDir(dir)) throw new UserError('bad_cwd', `${cwd} is not a directory`)
    return dir
  }
  const first = ctx.hub.snapshot?.panes.find(p => p.workspace_id === workspace)
  return (first && paneCwd(first)) || ctx.home
}

export const newSession = defineAction(
  object({
    workspace: optional(id),
    newWorkspace: optional(workspaceLabel),
    agent: optional(oneOf(['claude', 'codex'])),
    cwd: optional(string({ max: 4096, pattern: /^(?:[/~][^\0\n\r]*)?$/ })),
    text: optional(string({ max: 100_000 })),
    model: optional(cliToken),
    effort: optional(cliToken),
    request: optional(requestId),
  }),
  {
    idempotent: true,
    async run(ctx, p) {
      if (!p.workspace === !p.newWorkspace)
        throw new UserError('bad_workspace', 'Give either a workspace or a name for a new one')
      if (p.workspace && !ctx.hub.workspace(p.workspace))
        throw new UserError('unknown_workspace', `No workspace ${p.workspace}`, 404)
      const kind = p.agent ?? null
      const dir = startDir(ctx, p.workspace ?? '', p.cwd)
      // A new workspace comes with a shell pane in its first tab: the agent starts there.
      const pane = p.workspace
        ? await ctx.herdr.createTab(p.workspace, dir, kind ?? 'shell')
        : await ctx.herdr.createWorkspace(dir, p.newWorkspace ?? '')
      if (p.cwd) ctx.dirs.record(dir)
      if (kind) {
        const text = (p.text ?? '').replace(/\r\n?/g, '\n').trim()
        const inline = rideArgv(text)
        await ctx.herdr.runInPane(
          pane,
          shellJoin(agentCommand(kind, p.model ?? '', p.effort ?? '', inline ? text : '')),
        )
        if (text && !inline) ctx.firstMessages.add(pane, text)
      }
      return { pane }
    },
  },
)

export const rename = defineAction(object({ pane: id, name: string({ max: 64, trim: true }) }), {
  refresh: true,
  async run(ctx, p) {
    requireAgent(ctx, p.pane)
    if (p.name && !AGENT_NAME.test(p.name))
      throw new UserError(
        'invalid_name',
        'A name starts with a lowercase letter, followed by up to 31 lowercase letters, digits, - or _',
      )
    await ctx.herdr.rename(p.pane, p.name || null)
    return undefined
  },
})

export const renameWorkspace = defineAction(object({ workspace: id, label: workspaceLabel }), {
  refresh: true,
  async run(ctx, p) {
    if (!ctx.hub.workspace(p.workspace)) throw new UserError('unknown_workspace', `No workspace ${p.workspace}`, 404)
    if (!p.label) throw new UserError('invalid_name', 'A workspace needs a name')
    await ctx.herdr.renameWorkspace(p.workspace, p.label)
    return undefined
  },
})

export const closeTab = defineAction(object({ tab: id }), {
  refresh: true,
  async run(ctx, p) {
    if (!ctx.hub.tab(p.tab)) throw new UserError('unknown_tab', `No tab ${p.tab}`, 404)
    await ctx.herdr.closeTab(p.tab)
    return undefined
  },
})

/** The user says which conversation a Codex pane shows (nothing ties a Codex process to its rollout file). */
export const pinSession = defineAction(object({ pane: id, path: string({ max: 4096 }) }), {
  refresh: true,
  async run(ctx, p) {
    const agent = requireAgent(ctx, p.pane)
    if (agent.agent !== 'codex') throw new UserError('not_codex', 'Only a Codex pane is matched to its conversation')
    if (!ctx.agents.isCodexRollout(p.path) || !(await ctx.agents.pinCodexSession(p.pane, paneCwd(agent), p.path)))
      throw new UserError('unknown_session', 'That conversation is not one this pane can be showing', 404)
    ctx.inbox.invalidate(p.pane)
    return undefined
  },
})

export const focus = defineAction(object({ pane: id }), {
  async run(ctx, p) {
    requireAgent(ctx, p.pane)
    await ctx.herdr.focusAgent(p.pane)
    return undefined
  },
})
