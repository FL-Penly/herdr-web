import { TtlCache } from '../lib/cache.ts'
import { JsonlTail } from '../lib/jsonl.ts'
import type { AgentKind, Thread, ThreadMeta, Turn } from '../protocol.ts'
import { claudeDefaultEffort } from './claude/settings.ts'
import { ClaudeTranscriptParser } from './claude/transcript.ts'
import { readCodexConfig } from './codex/config.ts'
import { historyBase } from './codex/locate.ts'
import { CodexRolloutParser } from './codex/rollout.ts'
import type { Entry, ParsedThread, TranscriptParser } from './transcript.ts'

const MAX_FORK_DEPTH = 5
/** The most turns one thread read returns; a larger request gets this many. */
export const MAX_TURNS = 1000
/** How much of a sent message is compared with the transcript; attachments and wrapping may differ after it. */
const SENT_MATCH_CHARS = 40
const HOUR = 3600_000

interface Source {
  tail: JsonlTail
  parser: TranscriptParser
}

const sources = new TtlCache<string, Source>(6 * HOUR, 40)

function createParser(kind: AgentKind, path: string): TranscriptParser {
  return kind === 'claude' ? new ClaudeTranscriptParser() : new CodexRolloutParser(path)
}

/** Parses everything appended to `path` since the last call; the parser is rebuilt if the file was rewritten. */
function parse(kind: AgentKind, path: string, limit = 0): { parsed: ParsedThread; offset: number; truncated: boolean } {
  const key = `${kind}:${path}@${limit}`
  const src = sources.get(key) ?? { tail: new JsonlTail(path, { limit }), parser: createParser(kind, path) }
  sources.set(key, src) // also on a hit: a transcript still being read stays cached
  const { rows, reset } = src.tail.read()
  if (reset) src.parser = createParser(kind, path)
  for (const { row, start, end } of rows) src.parser.ingest(row, { start, end })
  const parsed = src.parser.snapshot()
  return { parsed, offset: src.tail.offset, truncated: parsed.truncated || src.tail.skipped }
}

/**
 * The items a Codex fork inherits: its history_base parent's rollout up to the fork point, recursively.
 * The parent prefix is immutable, so each one is parsed once and stays cached.
 */
function forkBaseEntries(path: string, depth = 1): { entries: Entry[]; truncated: boolean } {
  if (depth > MAX_FORK_DEPTH) return { entries: [], truncated: false }
  const base = historyBase(path)
  if (!base) return { entries: [], truncated: false }
  const { parsed, truncated } = parse('codex', base.path, base.endOffset)
  // Once a base lost its oldest rows, its own ancestors would not join up with what is left.
  if (truncated) return { entries: parsed.entries.map(e => ({ ...e, source: depth })), truncated }
  const older = forkBaseEntries(base.path, depth + 1)
  return {
    entries: [...older.entries, ...parsed.entries.map(e => ({ ...e, source: depth }))],
    truncated: older.truncated,
  }
}

/**
 * Groups items into turns, each opened by a user message; ids come from source offsets, so they are stable.
 * `more` counts the older turns a larger `maxTurns` would return.
 */
export function buildTurns(entries: readonly Entry[], maxTurns: number): { turns: Turn[]; more: number } {
  const turns: Turn[] = []
  let cur: Turn | null = null
  for (const { item, start, source } of entries) {
    const id = source ? `b${source}-${start}` : `${start}`
    if (item.type === 'user') {
      cur = { id, user: item, steps: [], start: item.ts, end: item.ts }
      turns.push(cur)
      continue
    }
    if (!cur) {
      cur = { id: `pre-${id}`, user: null, steps: [], start: item.ts, end: item.ts }
      turns.push(cur)
    }
    cur.steps.push(item)
    if (item.ts) cur.end = Math.max(cur.end, item.ts)
    if (item.forkAt) cur.forkAt = item.forkAt
  }
  const shown = Math.max(0, maxTurns)
  return { turns: shown ? turns.slice(-shown) : [], more: Math.max(0, turns.length - shown) }
}

/**
 * The transcript at `path` as turns (newest `maxTurns`, at most MAX_TURNS), plus thread metadata.
 * Incremental across calls.
 */
export function readThread(kind: AgentKind, path: string, maxTurns: number): Thread {
  const own = parse(kind, path)
  const { parsed, offset } = own
  // A transcript whose own start was cut has lost the link to a fork base too.
  const base = kind === 'codex' && !own.truncated ? forkBaseEntries(path) : { entries: [], truncated: false }
  const { turns, more: older } = buildTurns([...base.entries, ...parsed.entries], Math.min(MAX_TURNS, maxTurns))
  const total = turns.length + older
  const more = Math.min(total, MAX_TURNS) - turns.length
  const meta: ThreadMeta = {
    model: parsed.model,
    effort: parsed.effort ?? defaultEffort(kind, parsed.model, parsed.cwd),
    todos: parsed.todos,
    pending: parsed.pending,
    goal: parsed.goal,
    version: `${path}:${offset}`,
    path,
    truncated: own.truncated || base.truncated || total > MAX_TURNS,
    maxTurns: MAX_TURNS,
    live: null,
  }
  return { turns, more, meta }
}

function defaultEffort(kind: AgentKind, model: string | null, cwd: string): string | null {
  return kind === 'codex' ? (readCodexConfig().effort ?? null) : claudeDefaultEffort(model, cwd)
}

const squeeze = (text: string) => text.replace(/\s+/g, '')

/**
 * Whether `turn` is the one `sent` started and it has produced nothing yet: no reply text and no tool call.
 * That is when Claude Code gives an interrupted prompt back; Codex never does, so this decides it for Codex.
 */
export function isUnansweredTurn(turn: Turn | null | undefined, sent: string): boolean {
  const want = squeeze(sent).slice(0, SENT_MATCH_CHARS)
  if (!turn?.user || !want || !squeeze(turn.user.text).startsWith(want)) return false
  return !turn.steps.some(step => step.type === 'text' || step.type === 'tool')
}
