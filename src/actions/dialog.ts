import { UserError } from '../server/http.ts'
import { defineAction, id, requireAgent } from './context.ts'
import { object, optional, string } from './validate.ts'

// A dialog option key: a digit or letter shortcut (sent as a key when nothing parses), or `nav:<offset>`.
const OPTION_KEY = /^(?:nav:-?\d{1,3}|[a-z0-9][\w+]{0,15})$/i

/** Pick an option by its label, if the dialog on screen still asks the question the browser showed. */
export const option = defineAction(
  object({
    pane: id,
    key: string({ max: 24, pattern: OPTION_KEY }),
    label: string({ max: 1_000 }),
    question: optional(string({ max: 10_000 })),
    text: optional(string({ max: 100_000 })),
  }),
  {
    serial: true,
    async run(ctx, p) {
      const agent = requireAgent(ctx, p.pane)
      await ctx.tui.chooseOption(p.pane, {
        key: p.key,
        label: p.label,
        question: p.question ?? null,
        text: p.text ?? null,
        blocked: agent.agent_status === 'blocked',
      })
      ctx.inbox.invalidate(p.pane)
      return undefined
    },
  },
)

/** Answer one of Codex's queued async questions, by option label or as free text ("Other"). */
export const asyncAnswer = defineAction(
  object({
    pane: id,
    question: string({ max: 10_000 }),
    option: optional(string({ max: 10_000 })),
    text: optional(string({ max: 100_000 })),
  }),
  {
    serial: true,
    async run(ctx, p) {
      requireAgent(ctx, p.pane)
      if (p.option === undefined && p.text === undefined)
        throw new UserError('bad_request', 'option or text is required')
      await ctx.tui.answerAsyncQuestion(p.pane, p.question, { option: p.option ?? null, text: p.text ?? null })
      ctx.inbox.invalidate(p.pane)
      return undefined
    },
  },
)

/**
 * The whole of a Claude Code permission dialog whose preview is taller than the pane, read by paging its view up
 * and back: until Claude records the change in its transcript, the screen is the only place that has it. The
 * text belongs to one episode: a later prompt can end on the very same rows and propose something else.
 */
export const revealDialog = defineAction(
  object({ pane: id, question: string({ max: 10_000 }), episode: string({ max: 100 }) }),
  {
    serial: true,
    readOnly: true,
    async run(ctx, p) {
      const agent = requireAgent(ctx, p.pane)
      if (agent.agent !== 'claude') throw new UserError('unsupported', 'Only Claude Code dialogs can be read this way')
      const dialog = ctx.inbox.dialog(p.pane)
      if (dialog?.episode !== p.episode) throw new UserError('stale_dialog', 'This dialog changed since it was shown')
      if (dialog.reason !== 'permission')
        throw new UserError('not_permission', 'Only permission dialogs can be read this way')
      // Every browser showing the card asks, but the view is paged once per episode.
      const reading = ctx.inbox.revealOnce(p.pane, p.episode, p.question, () =>
        ctx.inbox.whileScrolled(p.pane, () => ctx.tui.revealDialog(p.pane, p.question)),
      )
      if (!reading) throw new UserError('stale_dialog', 'This dialog changed since it was shown')
      const text = await reading
      if (text === null) throw new UserError('not_revealed', 'The top of this dialog could not be read')
      return { text, episode: p.episode }
    },
  },
)
