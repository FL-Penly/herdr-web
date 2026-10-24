import { lastReply, locateTranscript, setLiveCodexPanes } from '../agents/index.ts'
import { type Agent, type Snapshot, herdr, isIdle } from '../herdr.ts'
import { branchStatus } from '../lib/git.ts'
import type { AgentKind, AgentView, Branch, InboxEntry } from '../protocol.ts'
import {
  type StatusLine,
  isResumePicker,
  lastLines,
  parseDialog,
  parseMenu,
  parseStatus,
  sameText,
} from '../tui/index.ts'
import { type Reply, classify } from './classify.ts'
import { ackKey, identityKey, replyKey, sinceKey } from './keys.ts'
import { InboxStore } from './store.ts'
import { cleanTitle } from './title.ts'

const SCREEN_ROWS = 60
// herdr reads the agent's state off its screen too: a tick or two after the view is back, it has caught up.
const SCROLL_SETTLE_MS = 2000
const SCREEN_MESSAGE_ROWS = 14
// Paging the view makes herdr report the agent `done` and then `blocked` again under a new state_change_seq,
// sometimes only after the view has settled: within this long after the view is back, while herdr reports
// nothing but `done` in between, that is still the same dialog. An answer makes it report `working`.
const REVEAL_BRIDGE_MS = 3000

/** One blocking dialog, from when it shows until it is answered or replaced. */
interface Episode {
  id: string
  /** herdr's state_change_seq when last seen. */
  seq: number
  /** `inputs` for the pane when it showed: anything typed since may have answered it. */
  inputs: number
  question: string
  /** The dialog's whole text read off the terminal, once per episode; a failed read is dropped. */
  reveal?: { question: string; text: Promise<string | null> }
}

export interface InboxDeps {
  readScreen(pane: string, rows: number): Promise<string>
  locateTranscript(v: { pane: string; kind: string; session: string | null; cwd: string }): Promise<string | null>
  lastReply(kind: AgentKind, path: string): { text: string; at: number } | null
  branchStatus(cwd: string): Promise<Branch | null>
  /** Tells the rollout locator which Codex panes are alive, before any of them is looked up. */
  liveCodexPanes(list: { pane: string; cwd: string }[]): void
  now(): number
}

const defaultDeps: InboxDeps = {
  readScreen: herdr.readScreen,
  locateTranscript,
  lastReply,
  branchStatus,
  liveCodexPanes: list => setLiveCodexPanes(list),
  now: Date.now,
}

type Labels = { workspaces: Map<string, string>; tabs: Map<string, string> }
type Chrome = Pick<StatusLine, 'ctx' | 'mode' | 'effort' | 'model'> & { ultra: boolean }

/** Builds the AgentView list from a herdr snapshot: the only stateful, I/O-doing part of the inbox. */
export class InboxService {
  private deps: InboxDeps
  private replies = new Map<string, { key: string; reply: Reply }>()
  // Status-line values outlive the frames that hide them: effort is shown only after it changes, and
  // dialogs replace the footer.
  private chrome = new Map<string, Chrome>()
  // While a pane's view is paged away from its dialog, herdr may see no dialog either and report the agent as
  // working: the pane keeps its last view until a moment after the view is back.
  private views = new Map<string, AgentView>()
  private frozenUntil = new Map<string, number>()
  private episodes = new Map<string, Episode>()
  // Keys, text or clicks herdr-web sent to a pane: herdr may report two prompts in a row as one blocked spell.
  private inputs = new Map<string, number>()
  private bridgeUntil = new Map<string, number>()
  // Episode ids are compared by browsers across server restarts, so they carry this process's id.
  private boot = crypto.randomUUID().slice(0, 8)
  private episodeCount = 0

  constructor(
    private store = new InboxStore(),
    deps: Partial<InboxDeps> = {},
  ) {
    this.deps = { ...defaultDeps, ...deps }
  }

  async build(snapshot: Snapshot): Promise<AgentView[]> {
    const now = this.deps.now()
    const labels: Labels = {
      workspaces: new Map(snapshot.workspaces.map(w => [w.workspace_id, w.label])),
      tabs: new Map(snapshot.tabs.map(t => [t.tab_id, t.label])),
    }
    this.deps.liveCodexPanes(
      snapshot.agents.filter(a => a.agent === 'codex').map(a => ({ pane: a.pane_id, cwd: a.foreground_cwd || a.cwd })),
    )
    const views = await Promise.all(snapshot.agents.map(a => this.view(a, labels, now)))
    for (const pane of this.store.prune(new Set(snapshot.agents.map(a => a.pane_id)), now)) {
      this.replies.delete(pane)
      this.chrome.delete(pane)
      this.views.delete(pane)
      this.frozenUntil.delete(pane)
      this.episodes.delete(pane)
      this.inputs.delete(pane)
      this.bridgeUntil.delete(pane)
    }
    this.store.flush()
    return views
  }

  ack(agent: Agent) {
    this.store.ack(agent.pane_id, ackKey(agent))
  }

  unack(pane: string) {
    this.store.unack(pane)
  }

  snooze(agent: Agent, minutes: number) {
    this.store.snooze(agent.pane_id, ackKey(agent), this.deps.now() + minutes * 60_000)
  }

  invalidate(pane: string) {
    this.replies.delete(pane)
  }

  /** herdr-web typed into `pane` (keys, a reply, an option): the dialog on screen may be another one now. */
  input(pane: string) {
    this.inputs.set(pane, (this.inputs.get(pane) ?? 0) + 1)
    this.bridgeUntil.delete(pane)
  }

  /** The blocking dialog the pane showed at the last tick, with its episode. */
  dialog(pane: string): { episode: string; reason: string; question: string } | null {
    const inbox = this.views.get(pane)?.inbox
    return inbox?.source === 'dialog' && inbox.episode
      ? { episode: inbox.episode, reason: inbox.reason, question: inbox.question }
      : null
  }

  /**
   * The text `read` returns for the dialog of `episode`, read once while that episode lasts: later callers
   * get the same text, a failure (null or an error) is not kept. Null without a read when the episode is over.
   */
  revealOnce(pane: string, episode: string, question: string, read: () => Promise<string | null>) {
    const current = this.episodes.get(pane)
    if (current?.id !== episode) return null
    if (current.reveal && sameText(current.reveal.question, question)) return current.reveal.text
    const reveal = { question, text: read() }
    current.reveal = reveal
    const forget = () => {
      if (current.reveal === reveal) current.reveal = undefined
    }
    reveal.text.then(text => {
      if (text === null) forget()
    }, forget)
    return reveal.text
  }

  /** Runs `fn`, which pages `pane`'s view away from its dialog, without the dialog leaving the inbox meanwhile. */
  async whileScrolled<T>(pane: string, fn: () => Promise<T>): Promise<T> {
    this.frozenUntil.set(pane, Number.POSITIVE_INFINITY)
    this.bridgeUntil.set(pane, Number.POSITIVE_INFINITY)
    try {
      return await fn()
    } finally {
      const now = this.deps.now()
      this.frozenUntil.set(pane, now + SCROLL_SETTLE_MS)
      // Typed into meanwhile (an option queued behind the read), or seen working: nothing to bridge.
      if (this.bridgeUntil.has(pane)) this.bridgeUntil.set(pane, now + SCROLL_SETTLE_MS + REVEAL_BRIDGE_MS)
    }
  }

  /**
   * Once the view is back, only `done` is the paging's own doing: anything else herdr reports means the dialog
   * was left. While the view is paged, the state herdr reads off it means nothing.
   */
  private watchBridge(a: Agent, now: number) {
    const until = this.bridgeUntil.get(a.pane_id)
    if (until === undefined || this.frozenUntil.get(a.pane_id) === Number.POSITIVE_INFINITY) return
    if (now >= until || (a.agent_status !== 'blocked' && a.agent_status !== 'done')) {
      this.bridgeUntil.delete(a.pane_id)
      if (now < until) this.episodes.delete(a.pane_id)
    }
  }

  /**
   * Which episode the dialog on screen belongs to. A new one starts when herdr's state_change_seq moved (the
   * agent left the dialog, even if the next one looks the same), when herdr-web typed into the pane, or when
   * the dialog asks something else. Only the blocked → done → blocked that paging the view causes is bridged.
   */
  private episode(a: Agent, question: string, now: number): string {
    const pane = a.pane_id
    const seq = a.state_change_seq ?? 0
    const inputs = this.inputs.get(pane) ?? 0
    const prev = this.episodes.get(pane)
    const bridged = now < (this.bridgeUntil.get(pane) ?? 0)
    if (prev && prev.inputs === inputs && sameText(prev.question, question) && (prev.seq === seq || bridged)) {
      // Blocked again under a new seq: the paging's done → blocked is over, and the next change is real.
      if (prev.seq !== seq) this.bridgeUntil.delete(pane)
      prev.seq = seq
      return prev.id
    }
    const id = `${this.boot}.${seq}.${++this.episodeCount}`
    this.episodes.set(pane, { id, seq, inputs, question })
    this.bridgeUntil.delete(pane)
    return id
  }

  private frozen(pane: string): AgentView | undefined {
    return this.deps.now() < (this.frozenUntil.get(pane) ?? 0) ? this.views.get(pane) : undefined
  }

  private async view(a: Agent, labels: Labels, now: number): Promise<AgentView> {
    this.watchBridge(a, now)
    const held = this.frozen(a.pane_id)
    if (held) return held
    const view = await this.freshView(a, labels, now)
    // Paging may have begun while this view was read.
    const late = this.frozen(a.pane_id)
    if (late) return late
    this.views.set(a.pane_id, view)
    return view
  }

  private async freshView(a: Agent, labels: Labels, now: number): Promise<AgentView> {
    const pane = a.pane_id
    const cwd = a.foreground_cwd || a.cwd
    const session = a.agent_session?.value ?? null
    const seen = this.store.observe(pane, identityKey(a), sinceKey(a), now)
    const [screen, branch] = await Promise.all([
      this.deps.readScreen(pane, SCREEN_ROWS).catch(() => ''),
      this.deps.branchStatus(cwd).catch(() => null),
    ])
    const status = parseStatus(screen)
    const { entry, reply } = await this.entry(a, screen, status, cwd, session, now)
    let since = seen.since
    if (seen.firstSeen && entry && a.agent_status !== 'blocked' && reply?.source === 'transcript' && reply.at) {
      since = reply.at
      this.store.setSince(pane, since)
    }
    return {
      pane,
      tab: a.tab_id,
      workspace: a.workspace_id,
      workspaceLabel: labels.workspaces.get(a.workspace_id) ?? a.workspace_id,
      tabLabel: labels.tabs.get(a.tab_id) ?? '',
      kind: a.agent,
      name: a.name ?? null,
      title: cleanTitle(a.terminal_title_stripped || a.label || '', cwd),
      cwd,
      status: a.agent_status,
      since,
      branch,
      session,
      activity: a.agent_status === 'working' ? status.activity : null,
      ...this.sticky(pane, status),
      asks: status.asks,
      shells: status.shells,
      inputBox: status.inputBox,
      inbox: entry,
    }
  }

  private async entry(a: Agent, screen: string, status: StatusLine, cwd: string, session: string | null, now: number) {
    const pane = a.pane_id
    const idle = isIdle(a.agent_status)
    const key = ackKey(a)
    const acked = this.store.isAcked(pane, key)
    // herdr reports Codex's /resume picker as blocked, but it is a menu the user opened, not a wait.
    const menu = idle || (a.agent_status === 'blocked' && isResumePicker(screen)) ? parseMenu(screen) : null
    const reply = idle && !menu && !acked ? await this.reply(a, screen, cwd, session) : null
    const classified: InboxEntry | null = classify({
      status: a.agent_status,
      asks: status.asks,
      menu,
      dialog: a.agent_status === 'blocked' ? parseDialog(screen) : null,
      reply,
      cwd,
      acked,
      snoozedUntil: this.store.snoozedUntil(pane, key, now),
      now,
    })
    let entry = classified
    if (classified?.source === 'dialog') entry = { ...classified, episode: this.episode(a, classified.question, now) }
    else if (a.agent_status !== 'blocked' && !this.bridgeUntil.has(pane)) this.episodes.delete(pane)
    return { entry, reply }
  }

  /** The transcript's last reply, cached until the state changes; else the screen's last rows, read each time. */
  private async reply(a: Agent, screen: string, cwd: string, session: string | null): Promise<Reply> {
    const key = replyKey(a)
    const hit = this.replies.get(a.pane_id)
    if (hit && hit.key === key) return hit.reply
    const reply = await this.transcriptReply(a, cwd, session)
    if (!reply) return { text: lastLines(screen, SCREEN_MESSAGE_ROWS), at: 0, source: 'screen' }
    this.replies.set(a.pane_id, { key, reply })
    return reply
  }

  private async transcriptReply(a: Agent, cwd: string, session: string | null): Promise<Reply | null> {
    if (a.agent !== 'claude' && a.agent !== 'codex') return null
    try {
      const path = await this.deps.locateTranscript({ pane: a.pane_id, kind: a.agent, session, cwd })
      const last = path ? this.deps.lastReply(a.agent, path) : null
      return last ? { ...last, source: 'transcript' } : null
    } catch {
      return null
    }
  }

  private sticky(pane: string, s: StatusLine): Chrome {
    const prev = this.chrome.get(pane) ?? { ctx: null, mode: null, effort: null, ultra: false, model: null }
    const next: Chrome = {
      ctx: s.inputBox ? s.ctx : prev.ctx,
      mode: s.inputBox ? s.mode : prev.mode,
      effort: s.effort ?? prev.effort,
      ultra: s.ultra ?? prev.ultra,
      model: s.model ?? prev.model,
    }
    this.chrome.set(pane, next)
    return next
  }
}
