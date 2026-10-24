// @ts-check

/** @typedef {import('../../src/protocol.ts').Command} Command */
/** @typedef {Command & { mark?: string }} PickerCommand */

/**
 * What the picker should complete at the caret: `/name` at the very start of the message, or a Codex `$skill` anywhere.
 * @param {string} beforeCaret
 * @param {string} kind
 * @returns {{ trigger: '/' | '$'; query: string; from: number } | null}
 */
export function slashQuery(beforeCaret, kind) {
  const slash = /^\/([^\s]*)$/.exec(beforeCaret)
  if (slash) return { trigger: '/', query: slash[1].toLowerCase(), from: 0 }
  if (kind !== 'codex') return null
  const skill = /(?:^|\s)\$([\w:.-]*)$/.exec(beforeCaret)
  if (!skill) return null
  return { trigger: '$', query: skill[1].toLowerCase(), from: beforeCaret.length - skill[1].length - 1 }
}

/**
 * The `/` list for Codex also offers its `$skills` (inserted with `$`); `$` lists only skills.
 * @param {'/' | '$'} trigger
 * @param {string} kind
 * @param {{ commands: Command[]; skills: Command[] }} catalog
 * @returns {PickerCommand[]}
 */
export function commandPool(trigger, kind, { commands, skills }) {
  if (trigger === '$') return skills
  if (kind === 'codex') return [...commands, ...skills.map(c => ({ ...c, mark: '$' }))]
  return commands
}

/**
 * 0 prefix · 1 word prefix (`-`/`:` separated) · 2 substring · 3 description match · 9 no match.
 * @param {Command} command
 * @param {string} query
 */
export function commandRank(command, query) {
  const name = command.name.toLowerCase()
  if (name.startsWith(query)) return 0
  if (name.split(/[-:]/).some(part => part.startsWith(query))) return 1
  if (name.includes(query)) return 2
  if (command.desc.toLowerCase().includes(query)) return 3
  return 9
}

/**
 * @template {Command} T
 * @param {T[]} pool
 * @param {string} query
 * @param {number} [limit]
 * @returns {T[]}
 */
export function rankCommands(pool, query, limit = 60) {
  return pool
    .map(c => /** @type {[number, T]} */ ([commandRank(c, query), c]))
    .filter(([rank]) => rank < 9)
    .sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length)
    .map(([, c]) => c)
    .slice(0, limit)
}
