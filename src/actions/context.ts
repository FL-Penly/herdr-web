import { basename } from 'node:path'
import { type Agent, HERDR_ID, type Pane, type Snapshot, type Tab, type Workspace, paneCwd } from '../herdr.ts'
import type { AgentKind, AgentStatus, ForkMode, Turn } from '../protocol.ts'
import { UserError } from '../server/http.ts'
import type { AsyncAnswer, ChooseOptions } from '../tui/index.ts'
import type { Check } from './validate.ts'
import { string } from './validate.ts'

/**
 * Everything an action may touch. main.ts wires the real herdr client, inbox, TUI driver and fork;
 * tests pass fakes. Shapes are structural so this layer does not depend on how those modules are built.
 */
export interface ActionContext {
  hub: {
    readonly snapshot: Snapshot | null
    agent(pane: string): Agent | null
    pane(id: string): Pane | null
    tab(id: string): Tab | null
    workspace(id: string): Workspace | null
    refresh(): Promise<void>
  }
  herdr: {
    sendKeys(pane: string, keys: string[]): Promise<unknown>
    prompt(pane: string, text: string): Promise<unknown>
    focusAgent(pane: string): Promise<unknown>
    waitAgent(pane: string, statuses: AgentStatus[], timeoutMs: number): Promise<boolean>
    rename(pane: string, name: string | null): Promise<unknown>
    createTab(workspace: string, cwd: string, label: string): Promise<string>
    createWorkspace(cwd: string, label: string): Promise<string>
    renameWorkspace(workspace: string, label: string): Promise<unknown>
    closeTab(tab: string): Promise<unknown>
    runInPane(pane: string, command: string): Promise<unknown>
  }
  inbox: {
    ack(agent: Agent): void
    unack(pane: string): void
    snooze(agent: Agent, minutes: number): void
    invalidate(pane: string): void
    /** herdr-web typed into the pane: a dialog on screen afterwards starts a new episode. */
    input(pane: string): void
    /** The blocking dialog on screen at the last tick, with its `InboxEntry.episode`. */
    dialog(pane: string): { episode: string; reason: string; question: string } | null
    /** `read`, once per episode (see InboxService.revealOnce); null when that episode is over. */
    revealOnce(
      pane: string,
      episode: string,
      question: string,
      read: () => Promise<string | null>,
    ): Promise<string | null> | null
    whileScrolled<T>(pane: string, fn: () => Promise<T>): Promise<T>
  }
  tui: {
    chooseOption(pane: string, o: ChooseOptions): Promise<void>
    answerAsyncQuestion(pane: string, question: string, o: AsyncAnswer): Promise<void>
    prepareReply(pane: string): Promise<void>
    /** Close a panel or menu over the input box (Esc, unless `escape` is false); `no_input_box` if it stays. */
    showInputBox(pane: string, o: { escape: boolean }): Promise<void>
    interruptAndRestore(pane: string, last: string): Promise<{ restored: boolean }>
    interrupt(pane: string): Promise<void>
    clearInput(pane: string): Promise<void>
    revealDialog(pane: string, question: string): Promise<string | null>
    /** What was typed into the agent's input box and not sent ('' when empty or out of view). */
    inputDraft(pane: string): Promise<string>
    /** Empty the input box, wherever its cursor is; fails with `terminal_draft` when it does not empty. */
    discardDraft(pane: string): Promise<void>
  }
  firstMessages: { add(pane: string, text: string): void; dismiss(pane: string): void }
  replyQueues: {
    add(pane: string, conversation: string | null, text: string): string
    remove(pane: string, id: string): boolean
    pause(pane: string): void
    resume(pane: string): void
  }
  /** Serializes everything that types into a pane, so two requests never interleave their keys. */
  locks: { run<T>(pane: string, fn: () => Promise<T>): Promise<T> }
  agents: {
    locateTranscript(v: { pane: string; kind: string; session: string | null; cwd: string }): Promise<string | null>
    codexSessionId(rolloutPath: string): string | null
    isCodexRollout(path: string): boolean
    lastTurn(kind: AgentKind, path: string): Turn | null
    /** Show `path` for a Codex pane from now on; false when it is not one of the pane's conversations. */
    pinCodexSession(pane: string, cwd: string, path: string): Promise<boolean>
  }
  fork(o: { pane: string; mode: ForkMode; session?: string; at?: string }): Promise<{ pane: string }>
  /**
   * Results of recent `idempotent` actions by `op:request`: a repeat while the first runs, or within 30 s
   * of it succeeding, gets the first result instead of doing it again. A failure is not kept.
   */
  requests: { getOrLoad(key: string, load: () => Promise<object>): Promise<object> }
  /** Folders for new sessions: checked to exist, and remembered for `/api/dirs`. */
  dirs: { isDir(path: string): boolean; record(dir: string): void }
  home: string
}

export interface ActionDef<P> {
  params: Check<P>
  run(ctx: ActionContext, params: P): Promise<object | undefined>
  /** Re-read herdr state before answering, so the client sees the effect in the next state push. */
  refresh?: boolean
  /**
   * Sends keys or text to `params.pane`: runs under that pane's lock, and a dialog shown afterwards is a new
   * episode (`InboxEntry.episode`), however much it looks like the one before.
   */
  serial?: boolean
  /** A `serial` action that only reads the pane (its keys move the view, never the input). */
  readOnly?: boolean
  /** Creates something (a tab, a fork): a repeated `params.request` returns the first result. */
  idempotent?: boolean
}

// Two arguments so P is inferred from the validator before the handler is typed against it.
export function defineAction<P>(params: Check<P>, def: Omit<ActionDef<P>, 'params'>): ActionDef<P> {
  return { params, ...def }
}

export const id: Check<string> = string({ pattern: HERDR_ID })

/** A client-generated id for one click, so a repeated or retried request is recognized. */
export const requestId: Check<string> = string({ max: 64, pattern: /^[\w.-]+$/ })

export function requirePane(ctx: ActionContext, pane: string): Pane {
  const found = ctx.hub.pane(pane)
  if (!found) throw new UserError('unknown_pane', `No pane ${pane}`, 404)
  return found
}

/** The transcript or rollout an agent pane is writing. */
export function transcriptOf(ctx: ActionContext, agent: Agent): Promise<string | null> {
  return ctx.agents.locateTranscript({
    pane: agent.pane_id,
    kind: agent.agent,
    session: agent.agent_session?.value ?? null,
    cwd: paneCwd(agent),
  })
}

/**
 * The conversation a pane shows, by session id: Codex goes on in a new rollout file when a session is resumed,
 * the same session all the same.
 */
export async function conversationOf(ctx: ActionContext, agent: Agent): Promise<string | null> {
  const path = await transcriptOf(ctx, agent)
  if (!path) return null
  return (agent.agent === 'codex' ? ctx.agents.codexSessionId(path) : null) ?? basename(path, '.jsonl')
}

export function requireAgent(ctx: ActionContext, pane: string): Agent {
  const agent = ctx.hub.agent(pane)
  if (!agent) throw new UserError('no_agent', `No agent in pane ${pane}`, 404)
  return agent
}
