// The approval card end to end on real captures: Claude Code shows a permission prompt before it writes the
// message holding the change to its transcript, and a change taller than the pane shows only its end.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cardKey, isCutPreview, needsReveal, pendingChange, revealedText } from '../../public/js/model.js'
import { readThread } from '../../src/agents/thread.ts'
import { parseDialog } from '../../src/tui/dialog.ts'
import { fixture } from '../agents/helpers.ts'
import { screen } from '../tui/fixtures.ts'

const dir = mkdtempSync(join(tmpdir(), 'approval-'))

/** The transcript as it is on disk at the moment the dialog is up: the first `rows` rows of the fixture. */
function transcriptAt(name: string, rows: number) {
  const path = join(dir, name)
  const lines = readFileSync(fixture('claude', 'parallel-writes.jsonl'), 'utf8').split('\n').filter(Boolean)
  writeFileSync(path, `${lines.slice(0, rows).join('\n')}\n`)
  return readThread('claude', path, 1)
}

describe('a Write approval whose file is taller than the pane', () => {
  const question = parseDialog(screen('claude-write-cut')).question

  test('the dialog holds only the end of the file, and says so', () => {
    expect(question.split('\n')[0]).toMatch(/^\s*38\s/)
    expect(question.endsWith('Do you want to create validate.js?')).toBe(true)
    expect(isCutPreview(question)).toBe(true)
  })

  test('before Claude records the message, nothing in the transcript is mistaken for it', () => {
    // Only the prompt and the thinking block: the tool_use rows come later (or once the dialog is answered).
    const thread = transcriptAt('early.jsonl', 2)
    expect(pendingChange(thread, question)).toBeNull()
  })

  test('once recorded, the card shows that file, not a sibling the preview mentions', () => {
    const thread = transcriptAt('late.jsonl', 5)
    const running = thread.turns[0].steps.filter(s => s.type === 'tool' && s.status === 'running')
    expect(running.map(s => (s.type === 'tool' ? s.detail : ''))).toEqual(['validate.js', 'logger.js', 'README.md'])
    // validate.js requires './logger.js', so the whole dialog text names logger.js too.
    const change = pendingChange(thread, `const log = require('./logger.js');\n${question}`)
    expect(change?.type === 'tool' && change.detail).toBe('validate.js')
    expect(change?.type === 'tool' && change.diff?.split('\n').length).toBeGreaterThan(60)
  })
})

describe('isCutPreview', () => {
  test('a dialog whose title is on screen shows all of it', () => {
    expect(
      isCutPreview(
        'Edit file\nstore.js\n 64 -  sweep() {\n 64 +  purge() {\nDo you want to make this edit to store.js?',
      ),
    ).toBe(false)
    expect(isCutPreview('rm -rf build && npm test\nDo you want to proceed?')).toBe(false)
  })

  test('a dialog that opens on a numbered or diff row lost its top', () => {
    expect(isCutPreview(' 37   let data;\n 38 }\nDo you want to create routes.js?')).toBe(true)
    expect(isCutPreview('  12 +  x\n  13 -  y\nDo you want to make this edit to a.js?')).toBe(true)
  })
})

describe('needsReveal', () => {
  const question = parseDialog(screen('claude-write-cut')).question
  const agent = (kind: string, reason = 'permission') => ({ kind, inbox: { reason, question, episode: 'e1' } })

  test('a cut Claude permission is read off the terminal until the transcript has its change', () => {
    expect(needsReveal(agent('claude'), transcriptAt('reveal-early.jsonl', 2))).toBe(true)
    expect(needsReveal(agent('claude'), transcriptAt('reveal-late.jsonl', 5))).toBe(false)
  })

  test('not for Codex, other dialogs, or a dialog shown whole', () => {
    const early = transcriptAt('reveal-other.jsonl', 2)
    expect(needsReveal(agent('codex'), early)).toBe(false)
    expect(needsReveal(agent('claude', 'choice'), early)).toBe(false)
    const whole = {
      kind: 'claude',
      inbox: { reason: 'permission', question: 'Create file\na.js\n 1 x\nDo you want to create a.js?' },
    }
    expect(needsReveal(whole, early)).toBe(false)
    expect(needsReveal(null, early)).toBe(false)
    // From a server that does not say which episode it is, nothing read could be told apart from the next one.
    expect(needsReveal({ kind: 'claude', inbox: { reason: 'permission', question } }, early)).toBe(false)
  })
})

describe('revealedText', () => {
  // GUIDE.md proposed twice: the second one recreates it with another heading, ending on the same rows.
  const question = parseDialog(screen('claude-write-cut')).question
  const first = { reason: 'permission', question, episode: 'a.10.1' }
  const second = { reason: 'permission', question, episode: 'a.14.2' }
  const key = cardKey(first)

  test('the two prompts look the same on screen and as cards', () => {
    expect(cardKey(second)).toBe(key)
  })

  test('a browser that read the first proposal does not show it for the second', () => {
    const stored = { episode: first.episode, key, value: '# Example Task Titles' }
    expect(revealedText(stored, first, key)).toBe('# Example Task Titles')
    expect(revealedText(stored, second, key)).toBeUndefined()
    expect(revealedText({ ...stored, value: 'reading' }, second, key)).toBeUndefined()
  })

  test('a fresh browser has nothing for either, and only what it read for the episode on screen', () => {
    expect(revealedText(undefined, second, key)).toBeUndefined()
    const read = { episode: second.episode, key, value: '# Revised Task Titles' }
    expect(revealedText(read, second, key)).toBe('# Revised Task Titles')
    expect(revealedText(read, { ...second, episode: undefined }, key)).toBeUndefined()
    expect(revealedText(read, second, cardKey({ ...second, question: 'Do you want to create b.js?' }))).toBeUndefined()
  })
})
