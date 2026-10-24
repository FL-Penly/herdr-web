import { join } from 'node:path'
import type { ParsedThread, TranscriptParser } from '../../src/agents/transcript.ts'
import { JsonlTail } from '../../src/lib/jsonl.ts'
import type { Item, ToolItem } from '../../src/protocol.ts'

export const fixture = (...parts: string[]) => join(import.meta.dir, '..', 'fixtures', ...parts)

export function parseFile(parser: TranscriptParser, path: string): ParsedThread {
  for (const { row, start, end } of new JsonlTail(path).read().rows) parser.ingest(row, { start, end })
  return parser.snapshot()
}

export const items = (t: ParsedThread): Item[] => t.entries.map(e => e.item)
export const tools = (t: ParsedThread): ToolItem[] => items(t).filter((i): i is ToolItem => i.type === 'tool')
export const tool = (t: ParsedThread, id: string): ToolItem => {
  const found = tools(t).find(i => i.id === id)
  if (!found) throw new Error(`no tool ${id}`)
  return found
}
