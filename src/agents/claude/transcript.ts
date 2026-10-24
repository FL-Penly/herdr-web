import type { Goal, ThreadMeta, ToolItem } from '../../protocol.ts'
import {
  ItemLog,
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

// The fields of a Claude Code transcript row (~/.claude/projects/<dir>/<session>.jsonl) that are read here.
interface ClaudeRow {
  type?: string
  uuid?: string
  timestamp?: string
  cwd?: string
  isSidechain?: boolean
  isMeta?: boolean
  /** On assistant rows: the effort the reply was generated with. */
  effort?: string
  /** `updates`: the thinking text is a progress note the TUI prints like a message (`● …`). */
  thinkingDisplay?: string
  message?: { model?: string; content?: unknown }
  attachment?: {
    type?: string
    met?: boolean
    /** Marks a `/goal` set (met: false) or clear (met: true) rather than a check of the condition. */
    sentinel?: boolean
    condition?: string
    reason?: string
    durationMs?: number
    tokens?: number
    iterations?: number
    /** `queued_command`: a message typed while the agent worked, taken into its turn (`prompt` mode, by a human). */
    prompt?: unknown
    commandMode?: string
    origin?: { kind?: string }
  }
}

interface ContentBlock {
  type?: string
  id?: string
  name?: string
  input?: Record<string, any>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  text?: string
  thinking?: string
}

/** Commands that only change settings or print a panel: hidden from the thread unless given arguments. */
const SILENT_COMMANDS = new Set(['/effort', '/model', '/copy', '/clear', '/compact', '/cost', '/status', '/config'])

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const LOCAL_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>$/
const EFFORT_SET = /^Set effort level to (\w+)/
const MODEL_SET_WITH_EFFORT = /^Set model to .* with `(\w+)` effort/
// Wrappers Claude Code puts around injected (not typed) user content.
const INJECTED = /^<(local-command|system-reminder|bash-|task-notification|user-prompt)/

export class ClaudeTranscriptParser implements TranscriptParser {
  private readonly tools = new Map<string, ToolItem>()
  private readonly log = new ItemLog(item => this.tools.delete(item.id))
  private model: string | null = null
  private effort: string | null = null
  private rowEffort: string | null = null
  private goal: Goal | null = null
  private todos: ThreadMeta['todos'] = []
  private cwd = ''

  ingest(input: unknown, at: RowSpan): void {
    const r = input as ClaudeRow
    if (r.isSidechain) return
    const ts = timestamp(r)
    if (r.cwd) this.cwd = r.cwd
    if (r.type === 'attachment' && r.attachment?.type === 'goal_status') this.goalStatus(r.attachment, ts, at)
    else if (r.type === 'attachment' && r.attachment?.type === 'queued_command') this.queued(r.attachment, ts, at)
    else if (r.type === 'assistant') this.assistant(r, ts, at)
    else if (r.type === 'user') this.user(r, ts, at)
  }

  snapshot(): ParsedThread {
    return {
      entries: this.log.entries,
      truncated: this.log.droppedItems > 0,
      model: this.model,
      effort: this.effort ?? this.rowEffort,
      goal: this.goal,
      todos: this.todos,
      cwd: this.cwd,
      pending: [],
    }
  }

  private goalStatus(a: NonNullable<ClaudeRow['attachment']>, ts: number, at: RowSpan): void {
    // `/goal clear` writes a met sentinel; its `Goal cleared` output lands in a system row this parser skips.
    if (a.sentinel && a.met) {
      this.goalCleared('Goal cleared', ts, at)
      return
    }
    this.goal = {
      text: a.condition ?? '',
      status: a.met ? 'complete' : 'active',
      secs: a.durationMs != null ? Math.round(a.durationMs / 1000) : undefined,
      tokens: a.tokens,
      turns: a.iterations,
    }
    if (a.met)
      this.log.push({ type: 'note', code: 'goal.complete', goal: { ...this.goal }, text: a.reason, ts }, at.start)
  }

  /**
   * A message the user sent while the agent worked. Claude Code writes no user row for it, only this record where
   * it took it into the turn; it is shown there, as the TUI does. Task notifications and other sessions' messages
   * come the same way and are not the user's.
   */
  private queued(a: NonNullable<ClaudeRow['attachment']>, ts: number, at: RowSpan): void {
    if (a.commandMode !== 'prompt' || a.origin?.kind !== 'human') return
    const images = Array.isArray(a.prompt) ? a.prompt.filter((c: ContentBlock) => c?.type === 'image').length : 0
    const text = userText(textOf(a.prompt).trim())
    if (text === null || (!text && !images)) return
    this.log.push({ type: 'user', text, images, ts }, at.start)
  }

  private goalCleared(text: string, ts: number, at: RowSpan): void {
    this.goal = null
    const last = this.log.last
    if (last?.type === 'note' && last.code === 'goal.cleared') return
    this.log.push({ type: 'note', code: 'goal.cleared', text, ts }, at.start)
  }

  private assistant(r: ClaudeRow, ts: number, at: RowSpan): void {
    if (r.message?.model && r.message.model !== '<synthetic>') this.model = r.message.model
    if (typeof r.effort === 'string' && r.effort) this.rowEffort = r.effort
    const content = r.message?.content
    if (!Array.isArray(content)) return
    for (const c of content as ContentBlock[]) {
      if (c.type === 'text' && c.text?.trim())
        this.log.push({ type: 'text', text: c.text, ts, forkAt: r.uuid }, at.start)
      else if (c.type === 'thinking' && r.thinkingDisplay === 'updates' && c.thinking?.trim())
        this.log.push({ type: 'text', text: c.thinking.trim(), ts }, at.start)
      else if (c.type === 'thinking') this.log.push({ type: 'think', ts }, at.start)
      else if (c.type === 'tool_use') this.toolUse(c, ts, at)
    }
  }

  private user(r: ClaudeRow, ts: number, at: RowSpan): void {
    const content = r.message?.content
    if (Array.isArray(content) && content.some((c: ContentBlock) => c?.type === 'tool_result')) {
      for (const c of content as ContentBlock[]) if (c.type === 'tool_result') this.toolResult(c)
      return
    }
    if (r.isMeta) return
    const raw = textOf(content).trim()
    const out = LOCAL_OUTPUT.exec(raw)
    if (out) {
      const text = (out[2] ?? '').replace(ANSI, '').trim()
      const effort = EFFORT_SET.exec(text) ?? MODEL_SET_WITH_EFFORT.exec(text)
      if (effort) this.effort = effort[1] ?? null
      if (/^Goal cleared/i.test(text)) this.goalCleared(text, ts, at)
      else if (text) this.log.push({ type: 'note', code: 'command', text, ts }, at.start)
      return
    }
    const images = Array.isArray(content) ? content.filter((c: ContentBlock) => c?.type === 'image').length : 0
    const text = userText(raw)
    if (text === null || (!text && !images)) return
    this.log.push({ type: 'user', text, images, ts }, at.start)
  }

  private toolUse(c: ContentBlock, ts: number, at: RowSpan): void {
    const item = toolItem(c, ts, this.cwd)
    if (c.name === 'TodoWrite') this.todos = todoList(c.input?.todos)
    this.tools.set(item.id, item)
    this.log.push(item, at.start)
  }

  private toolResult(c: ContentBlock): void {
    const item = this.tools.get(c.tool_use_id ?? '')
    if (!item) return
    item.status = c.is_error ? 'error' : 'ok'
    if (c.is_error || (item.tool !== 'edit' && item.tool !== 'read' && item.tool !== 'plan'))
      item.output = clip(textOf(c.content))
    this.tools.delete(item.id)
  }
}

/** What the user typed, from a user row's text; null for rows that are not shown. */
export function userText(raw: string): string | null {
  if (!raw.startsWith('<')) return raw
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw)?.[1]?.trim()
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim() ?? ''
    if (SILENT_COMMANDS.has(name) && !args) return null
    return args ? `${name} ${args}` : name
  }
  return INJECTED.test(raw) ? null : raw
}

function todoList(todos: unknown): ThreadMeta['todos'] {
  if (!Array.isArray(todos)) return []
  return todos.map(t => ({ content: String(t?.content ?? ''), status: String(t?.status ?? '') }))
}

function toolItem(c: ContentBlock, ts: number, cwd: string): ToolItem {
  const inp = c.input ?? {}
  const name = c.name ?? ''
  const base: ToolItem = { type: 'tool', id: c.id ?? '', tool: 'other', op: 'call', detail: '', status: 'running', ts }
  const rel = (p: unknown) => shortPath(typeof p === 'string' ? p : '', cwd)
  switch (name) {
    case 'Bash':
      return { ...base, tool: 'cmd', op: 'run', detail: inp.command ?? '' }
    case 'Read':
    case 'NotebookRead':
      return { ...base, tool: 'read', op: 'file', detail: rel(inp.file_path ?? inp.notebook_path) }
    case 'Edit':
      return {
        ...base,
        tool: 'edit',
        op: 'edit',
        path: inp.file_path,
        detail: rel(inp.file_path),
        added: countLines(inp.new_string),
        removed: countLines(inp.old_string),
        diff: simpleDiff(inp.old_string ?? '', inp.new_string ?? ''),
      }
    case 'MultiEdit': {
      const edits: { old_string?: string; new_string?: string }[] = Array.isArray(inp.edits) ? inp.edits : []
      return {
        ...base,
        tool: 'edit',
        op: 'edit',
        path: inp.file_path,
        detail: rel(inp.file_path),
        added: edits.reduce((s, e) => s + countLines(e.new_string), 0),
        removed: edits.reduce((s, e) => s + countLines(e.old_string), 0),
        diff: edits.map(e => simpleDiff(e.old_string ?? '', e.new_string ?? '')).join('\n@@\n'),
      }
    }
    case 'Write':
      return {
        ...base,
        tool: 'edit',
        op: 'write',
        path: inp.file_path,
        detail: rel(inp.file_path),
        added: countLines(inp.content),
        removed: 0,
        diff: simpleDiff('', inp.content ?? ''),
      }
    case 'Grep':
    case 'Glob':
      return {
        ...base,
        tool: 'search',
        op: name === 'Grep' ? 'grep' : 'search',
        detail: `${inp.pattern ?? ''}${inp.path ? `  ${rel(inp.path)}` : ''}`,
      }
    case 'WebFetch':
    case 'WebSearch':
      return { ...base, tool: 'web', op: name === 'WebFetch' ? 'fetch' : 'search', detail: inp.url ?? inp.query ?? '' }
    case 'Task':
    case 'Agent':
      return { ...base, tool: 'task', op: 'task', detail: inp.description ?? inp.subagent_type ?? '' }
    case 'TodoWrite': {
      const todos: { status?: string }[] = Array.isArray(inp.todos) ? inp.todos : []
      return {
        ...base,
        tool: 'todo',
        op: 'update',
        detail: `${todos.filter(t => t.status === 'completed').length}/${todos.length}`,
      }
    }
    case 'ExitPlanMode':
      return { ...base, tool: 'plan', op: 'plan', ...planText(inp.plan) }
    case 'Skill':
      return { ...base, tool: 'skill', op: 'skill', detail: inp.skill ?? inp.command ?? '' }
    case 'AskUserQuestion': {
      const questions: { question?: string }[] = Array.isArray(inp.questions) ? inp.questions : []
      return { ...base, tool: 'ask', op: 'ask', detail: questions.map(q => q.question).join(' / ') }
    }
    default:
      return {
        ...base,
        name: name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name,
        detail: JSON.stringify(inp).slice(0, 200),
      }
  }
}
