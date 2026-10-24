import type { Ask, Goal, ToolItem, UserItem } from '../../protocol.ts'
import {
  ItemLog,
  MAX_DIFF,
  type ParsedThread,
  type RowSpan,
  type TranscriptParser,
  clip,
  countLines,
  planText,
  shortPath,
  simpleDiff,
  textOf,
  timestamp,
} from '../transcript.ts'

// The fields of a Codex rollout line (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) that are read here.
interface RolloutLine {
  type?: string
  timestamp?: string
  payload?: Record<string, any>
}

interface CodexGoal {
  objective?: string
  status?: string
  timeUsedSeconds?: number
  tokensUsed?: number
}

interface PendingAsk {
  item: ToolItem
  questions: (Ask & { id?: string })[]
  async: boolean
  /** The turn that asked ended; Codex drops async questions still unanswered then. */
  expired?: boolean
}

const ASK_TOOL = /^request_user_input(_async)?$/
const TOOL_OUTPUT = /^(custom_tool_call|function_call)_output$/
const USER_GOAL = /<codex_internal_context source="user_goal">\s*([\s\S]*?)\s*<\/codex_internal_context>/
const GOAL_SET = /^User set the goal: "([\s\S]*)"\s*\n/
const QUESTION_REPLY = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*(<\/send_user_message_question_reply>)?$/
const MAX_PENDING = 6

export class CodexRolloutParser implements TranscriptParser {
  private readonly asks = new Map<string, PendingAsk>()
  private readonly log = new ItemLog(item => this.asks.delete(item.id))
  private model: string | null = null
  private effort: string | null = null
  private goal: Goal | null = null
  private cwd = ''

  /** `path` is only used to build fork marks (`<path>#<byte offset>`). */
  constructor(private readonly path: string) {}

  ingest(input: unknown, at: RowSpan): void {
    const r = input as RolloutLine
    const p = r.payload ?? {}
    const ts = timestamp(r)
    if (r.type === 'response_item') {
      this.responseItem(p, ts, at)
      return
    }
    if (r.type === 'session_meta' && p.cwd) this.cwd = p.cwd
    if (r.type === 'turn_context' && p.model) {
      this.model = p.model
      if (p.effort) this.effort = p.effort
      if (p.cwd) this.cwd = p.cwd
    }
    if (r.type !== 'event_msg') return
    if (p.type === 'thread_goal_updated' && p.goal) this.goalUpdated(p.goal, ts, at)
    else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
      for (const ask of this.asks.values()) if (ask.async) ask.expired = true
      const last = this.log.last
      if (last && p.type === 'task_complete') last.forkAt = `${this.path}#${at.end}`
    } else if (p.type === 'item_completed') this.itemCompleted(p.item ?? {}, ts, at)
  }

  snapshot(): ParsedThread {
    return {
      entries: this.log.entries,
      truncated: this.log.droppedItems > 0,
      model: this.model,
      effort: this.effort,
      goal: this.goal,
      todos: [],
      cwd: this.cwd,
      pending: this.pending(),
    }
  }

  /** Async questions Codex asked without blocking, still unanswered. */
  private pending(): Ask[] {
    return [...this.asks.values()]
      .filter(a => a.async && !a.expired)
      .flatMap(a => a.questions.filter(q => q.answer == null))
      .slice(-MAX_PENDING)
      .map(({ call, title, options }) => ({ call, title, options }))
  }

  private responseItem(p: Record<string, any>, ts: number, at: RowSpan): void {
    if (p.type === 'function_call' && ASK_TOOL.test(p.name)) this.ask(p, ts, at)
    else if (p.type === 'message' && p.role === 'user') this.userGoalContext(textOf(p.content), ts, at)
    else if (TOOL_OUTPUT.test(p.type)) this.toolOutput(p, ts, at)
  }

  private toolOutput(p: Record<string, any>, ts: number, at: RowSpan): void {
    const goal = goalInToolOutput(p.output)
    if (goal?.status === 'complete' && this.goal?.status !== 'complete') {
      this.goal = toGoal(goal)
      this.log.push({ type: 'note', code: 'goal.complete', goal: { ...this.goal }, ts }, at.start)
    }
    const ask = p.type === 'function_call_output' ? this.asks.get(p.call_id) : undefined
    if (ask && !ask.async) {
      const answers = parseJson(p.output)?.answers ?? {}
      for (const q of ask.questions) {
        const a = q.id ? answers[q.id]?.answers : undefined
        if (Array.isArray(a) && a.length) q.answer = a.join(', ')
      }
      ask.item.status = 'ok'
      ask.item.output = askOutput(ask.questions)
    }
  }

  private ask(p: Record<string, any>, ts: number, at: RowSpan): void {
    const args = parseJson(p.arguments || '{}') ?? {}
    const questions = (Array.isArray(args.questions) ? args.questions : []).map((q: any) => ({
      call: p.call_id,
      id: q.id,
      title: String(q.title ?? q.question ?? ''),
      options: (Array.isArray(q.options) ? q.options : []).map((o: any) =>
        String(typeof o === 'string' ? o : (o?.label ?? '')),
      ),
    }))
    const item: ToolItem = {
      type: 'tool',
      id: p.call_id,
      tool: 'ask',
      op: 'ask',
      detail: questions
        .map((q: Ask) => q.title)
        .join(' / ')
        .slice(0, 200),
      status: 'running',
      output: askOutput(questions),
      ts,
    }
    this.asks.set(p.call_id, { item, questions, async: p.name === 'request_user_input_async' })
    this.log.push(item, at.start)
  }

  // `/goal X` reaches the model as injected context, not as a user message.
  private userGoalContext(text: string, ts: number, at: RowSpan): void {
    const ctx = USER_GOAL.exec(text)?.[1]
    if (ctx == null) return
    const set = GOAL_SET.exec(`${ctx}\n`)
    if (set) this.log.push({ type: 'user', text: `/goal ${set[1]}`, images: 0, ts }, at.start)
    else if (/User cleared the goal/i.test(ctx)) {
      this.goal = null
      this.log.push({ type: 'note', code: 'goal.cleared', ts }, at.start)
    }
  }

  private goalUpdated(g: CodexGoal, ts: number, at: RowSpan): void {
    const was = this.goal?.status
    this.goal = toGoal(g)
    const status = this.goal.status
    if (status === was || status === 'active') return
    const code = status === 'paused' ? 'goal.paused' : status === 'complete' ? 'goal.complete' : 'goal.status'
    this.log.push(
      { type: 'note', code, goal: { ...this.goal }, text: code === 'goal.status' ? status : undefined, ts },
      at.start,
    )
  }

  private itemCompleted(it: Record<string, any>, ts: number, at: RowSpan): void {
    const id = it.id ?? String(ts)
    const tool = (t: Omit<ToolItem, 'type' | 'id' | 'ts'> & { id?: string }) =>
      this.log.push({ type: 'tool', id, ts, ...t }, at.start)
    switch (it.type) {
      case 'UserMessage': {
        const raw = textOf(it.content).trim()
        const answers = this.answered(raw)
        const images = (Array.isArray(it.content) ? it.content : []).filter((c: any) => /image/i.test(c?.type)).length
        const item: UserItem = answers
          ? { type: 'user', text: '', images, answers, ts }
          : { type: 'user', text: raw, images, ts }
        if (raw || images) this.log.push(item, at.start)
        break
      }
      case 'AgentMessage': {
        // A request_user_input call is echoed as an AgentMessage under the call's id; its ask item already shows it.
        if (this.asks.has(it.id)) break
        const text = textOf(it.content).trim()
        if (text) this.log.push({ type: 'text', text, ts }, at.start)
        break
      }
      case 'Reasoning':
        this.log.push({ type: 'think', ts }, at.start)
        break
      case 'CommandExecution':
        tool({
          tool: 'cmd',
          op: 'run',
          detail: commandLine(it.command),
          status: execStatus(it),
          output: clip(String(it.aggregated_output ?? '')),
        })
        break
      case 'FileChange':
        for (const [path, change] of Object.entries<any>(it.changes ?? {})) {
          const op = change?.type === 'add' ? 'create' : change?.type === 'delete' ? 'delete' : 'edit'
          tool({
            id: `${id}${path}`,
            tool: 'edit',
            op,
            path,
            detail: shortPath(path, this.cwd),
            status: 'ok',
            ...fileDiff(change),
          })
        }
        break
      case 'Plan':
        tool({ tool: 'plan', op: 'plan', status: 'ok', ...planText(it.text) })
        break
      case 'ImageView':
        tool({ tool: 'read', op: 'image', detail: String(it.path ?? '').replace('file://', ''), status: 'ok' })
        break
      case 'McpToolCall':
        tool({
          tool: 'other',
          op: 'call',
          name: `${it.server ?? ''} · ${it.tool ?? ''}`,
          detail: '',
          status: it.error ? 'error' : 'ok',
        })
        break
      case 'SubAgentActivity':
        if (it.kind === 'started')
          tool({
            id: it.agent_thread_id ?? id,
            tool: 'task',
            op: 'subagent',
            detail: it.agent_path ?? '',
            status: 'ok',
          })
        break
    }
  }

  /**
   * A reply to async questions, typed in the Codex answer panel. Marks the matching asks answered and
   * returns the answers, or null when `text` is an ordinary message.
   */
  private answered(text: string): { question: string; answer: string }[] | null {
    const m = QUESTION_REPLY.exec(text)
    if (!m) return null
    const list = parseJson(m[1] ?? '')
    if (!Array.isArray(list)) return []
    const answers: { question: string; answer: string }[] = []
    for (const x of list) {
      const answer = String(x?.answer ?? '')
      const found = this.findQuestion(x)
      if (found) {
        const [ask, q] = found
        q.answer = answer
        ask.item.output = askOutput(ask.questions)
        if (ask.questions.every(q => q.answer != null)) ask.item.status = 'ok'
      }
      answers.push({ question: String(x?.question ?? ''), answer })
    }
    return answers
  }

  /** The question a reply answers: by its questionItemId, else the first unanswered one with its title. */
  private findQuestion(reply: any): [PendingAsk, PendingAsk['questions'][number]] | null {
    // questionItemId is a JSON array: ["request_user_input_async", <call id>, <question index>].
    const ref = parseJson(reply?.questionItemId)
    if (Array.isArray(ref) && ref[1]) {
      const ask = this.asks.get(ref[1])
      const q = ask?.questions[Number(ref[2]) || 0]
      return ask && q ? [ask, q] : null
    }
    for (const ask of this.asks.values()) {
      const q = ask.questions.find(q => q.title === reply?.question && q.answer == null)
      if (q) return [ask, q]
    }
    return null
  }
}

function toGoal(g: CodexGoal): Goal {
  return { text: g.objective ?? '', status: g.status ?? '', secs: g.timeUsedSeconds, tokens: g.tokensUsed }
}

function parseJson(s: unknown): any {
  if (typeof s !== 'string') return s
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** The goal a get_goal/update_goal call returned: a JSON string, or text parts when called from a script. */
export function goalInToolOutput(output: unknown): CodexGoal | null {
  const parts = Array.isArray(output) ? output.map(c => (typeof c?.text === 'string' ? c.text : '')) : [output]
  for (const part of parts) {
    if (typeof part !== 'string' || !part.includes('"goal"')) continue
    const goal = parseJson(part.trim())?.goal
    if (goal && typeof goal === 'object' && typeof goal.threadId === 'string') return goal
  }
  return null
}

export function askOutput(questions: Ask[]): string {
  return questions
    .map(q => {
      const options = q.options.map(o => `${o === q.answer ? '●' : '○'} ${o}`).join('\n')
      const free = q.answer != null && !q.options.includes(q.answer) ? `\n→ ${q.answer}` : ''
      return `${q.title}\n${options}${free}`
    })
    .join('\n\n')
}

/**
 * The diff and line counts of one FileChange entry: `add {content}`, `delete {content}` or
 * `update {unified_diff}`.
 */
function fileDiff(change: any): { diff: string; added: number; removed: number } {
  if (typeof change?.unified_diff === 'string')
    return { diff: clip(change.unified_diff, MAX_DIFF), ...diffStat(change.unified_diff) }
  const content = String(change?.content ?? '')
  return change?.type === 'delete'
    ? { diff: simpleDiff(content, ''), added: 0, removed: countLines(content) }
    : { diff: simpleDiff('', content), added: countLines(content), removed: 0 }
}

/** Added and removed lines of a unified diff. `---`/`+++` before the first `@@` are file headers, not lines. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (!inHunk && /^(---|\+\+\+) /.test(line)) continue
    else if (line[0] === '+') added++
    else if (line[0] === '-') removed++
  }
  return { added, removed }
}

/** The command as typed: Codex wraps it in `<shell> -lc <script>`. */
export function commandLine(command: unknown): string {
  if (!Array.isArray(command)) return String(command ?? '')
  return command.length >= 3 && /sh$/.test(String(command[0])) ? command.slice(2).join(' ') : command.join(' ')
}

function execStatus(it: { exit_code?: number | null; status?: string }): ToolItem['status'] {
  if (it.exit_code === 0) return 'ok'
  return it.status === 'completed' && it.exit_code == null ? 'ok' : 'error'
}
