import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function screen(name: string): string {
  return readFileSync(join(import.meta.dir, '..', 'fixtures', 'screens', `${name}.txt`), 'utf8')
}

/** A synthetic Claude input box: a rule, `❯` + NBSP + `input` (continuation rows indented), a rule, `footer`. */
export function claudeBox(input: string[] = [], footer: string[] = []): string {
  const rule = '─'.repeat(40)
  const [first = '', ...rest] = input
  return [rule, `❯\u00a0${first}`, ...rest.map(r => `  ${r}`), rule, ...footer].join('\n')
}
