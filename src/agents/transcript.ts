import type { Ask, Goal, Item, ThreadMeta, ToolItem } from '../protocol.ts'

export interface RowSpan {
  start: number
  end: number
}

/** An item plus the offset of the row it came from, which gives turns a stable id. */
export interface Entry {
  item: Item
  start: number
  /** Set on items inherited from a fork's ancestor: 1 for the parent, 2 for its parent, … */
  source?: number
}

export interface ParsedThread {
  entries: readonly Entry[]
  /** Items were trimmed off the front to bound memory: older history exists that is not in `entries`. */
  truncated: boolean
  model: string | null
  effort: string | null
  goal: Goal | null
  todos: ThreadMeta['todos']
  cwd: string
  pending: Ask[]
}

/** Turns transcript rows into items. Pure: no I/O, fed one row at a time. */
export interface TranscriptParser {
  ingest(row: unknown, at: RowSpan): void
  snapshot(): ParsedThread
}

export const MAX_ITEMS = 4000
const MAX_OUTPUT = 6000
export const MAX_DIFF = 12_000

export function clip(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s
}

const lines = (s: string): string[] => (s ? s.replace(/\n$/, '').split('\n') : [])

// A trailing newline ends the last line rather than starting an empty one, as in `git diff --stat`.
export function countLines(s: unknown): number {
  return typeof s === 'string' ? lines(s).length : 0
}

export function shortPath(path: string, cwd: string): string {
  return path && cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path || ''
}

export function simpleDiff(before: string, after: string): string {
  const removed = lines(before).map(l => `-${l}`)
  const added = lines(after).map(l => `+${l}`)
  return clip([...removed, ...added].join('\n'), MAX_DIFF)
}

const TEXT_PARTS = new Set(['text', 'input_text', 'output_text', 'Text'])

/** The text of a message `content`: a string, or the text parts of a content array. */
/**
 * A proposed plan as markdown (Codex may wrap it in `<proposed_plan>`), and its title: the first heading, or
 * its first line.
 */
export function planText(raw: unknown): { output: string; detail: string } {
  const output = String(raw ?? '')
    .replace(/^\s*<proposed_plan>\s*|\s*<\/proposed_plan>\s*$/g, '')
    .trim()
  const first = output.split('\n').find(l => l.trim()) ?? ''
  return {
    output,
    detail: first
      .replace(/^#+\s*/, '')
      .trim()
      .slice(0, 200),
  }
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(c => (typeof c === 'string' ? c : TEXT_PARTS.has(c?.type) && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
}

export function timestamp(row: { timestamp?: unknown }): number {
  return typeof row.timestamp === 'string' ? Date.parse(row.timestamp) || 0 : 0
}

/**
 * The items of one transcript, bounded to MAX_ITEMS. Trimming cuts at a user message so the oldest
 * surviving turn stays whole, and tells the owner which tool items were dropped.
 */
export class ItemLog {
  entries: Entry[] = []
  droppedTurns = 0
  droppedItems = 0

  constructor(private readonly onDrop: (item: ToolItem) => void = () => {}) {}

  push(item: Item, start: number): void {
    this.entries.push({ item, start })
    if (this.entries.length > MAX_ITEMS) this.trim()
  }

  get last(): Item | undefined {
    return this.entries[this.entries.length - 1]?.item
  }

  private trim(): void {
    const excess = this.entries.length - MAX_ITEMS
    let cut = this.entries.findIndex((e, i) => i >= excess && e.item.type === 'user')
    if (cut < 0) cut = excess
    for (const { item } of this.entries.slice(0, cut)) {
      if (item.type === 'user') this.droppedTurns++
      else if (item.type === 'tool') this.onDrop(item)
    }
    this.droppedItems += cut
    this.entries.splice(0, cut)
  }
}
