import { describe, expect, test } from 'bun:test'
import { parseDialog } from '../../src/tui/dialog.ts'
import { createDriver } from '../../src/tui/driver.ts'
import { SCROLL_TO_END, SCROLL_UP, revealedDialog, scrolledRows, stitchRows } from '../../src/tui/reveal.ts'
import { screen } from './fixtures.ts'

// A real Claude Code 2.1 prompt to create a 111-line docs.md in a 40-row pane: p00 is the screen as it was,
// each next page one PageUp further, p06 the first that shows the dialog's top rule and title.
const pages = ['00', '01', '02', '03', '04', '05', '06'].map(n => screen(`claude-scroll/p${n}`))

describe('revealedDialog', () => {
  test('pages up to the title and joins the pages into the whole file', () => {
    for (let n = 1; n < pages.length; n++) expect(revealedDialog(pages.slice(0, n))).toBeUndefined()
    const text = revealedDialog(pages) ?? ''
    const rows = text.split('\n')
    expect(rows.slice(0, 3)).toEqual(['Create file', 'docs.md', '   1 # Service Guide'])
    expect(rows.at(-1)).toBe('Do you want to create docs.md?')
    const numbers = rows.flatMap(r => /^\s*(\d+)(?:\s|$)/.exec(r)?.[1] ?? []).map(Number)
    expect(numbers).toEqual(Array.from({ length: 111 }, (_, i) => i + 1))
    // A row the TUI wrapped at the pane's edge is one line again, the word broken there included.
    expect(text).toContain('which endpoints exist today, and which building blocks')
    expect(text).not.toContain('Jump to bottom')
    expect(text).not.toContain('╌')
  })

  test('a dialog whose top is on screen needs no paging', () => {
    const shown = [
      '● Write(a.js)',
      '─'.repeat(60),
      ' Create file',
      ' a.js',
      '╌'.repeat(60),
      '  1 const a = 1',
      '╌'.repeat(60),
      ' Do you want to create a.js?',
      ' ❯ 1. Yes',
      '   2. No',
      '',
    ].join('\n')
    expect(revealedDialog([shown])).toBe('Create file\na.js\n 1 const a = 1\nDo you want to create a.js?')
  })

  test('null without a dialog, or when a page does not overlap the one below', () => {
    expect(revealedDialog(['just text\n'])).toBeNull()
    expect(revealedDialog([pages[0] ?? '', pages[2] ?? ''])).toBeNull()
  })

  test('a scrolled page loses its pinned prompt and everything from the jump note down', () => {
    const rows = scrolledRows(pages[1] ?? '')
    expect(rows[0]).toBe('   72')
    expect(rows.at(-1)).toBe('  100')
    expect(stitchRows(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(stitchRows(['a', 'b'], ['b', 'c'])).toBeNull()
  })
})

describe('driver.revealDialog', () => {
  const question = () => parseDialog(pages[0] ?? '').question

  test('pages up until the top shows, then back to the bottom', async () => {
    const sent: string[] = []
    let reads = 0
    const screens = [...pages, pages[0] ?? '']
    const driver = createDriver({
      readScreen: async () => screens[Math.min(reads++, screens.length - 1)] ?? '',
      readStyled: async () => '',
      sendKeys: async () => {},
      sendText: async (_pane, text) => void sent.push(text),
      sleep: async () => {},
    })
    const text = await driver.revealDialog('w1:p1', question())
    expect(text?.startsWith('Create file\ndocs.md\n')).toBe(true)
    expect(sent).toEqual([...Array(6).fill(SCROLL_UP), SCROLL_TO_END])
  })

  test('fails as stale when the dialog asks something else, and gives up when the view does not move', async () => {
    const still = createDriver({
      readScreen: async () => pages[0] ?? '',
      readStyled: async () => '',
      sendKeys: async () => {},
      sendText: async () => {},
      sleep: async () => {},
    })
    expect(await still.revealDialog('w1:p1', question())).toBeNull()
    const err = await still.revealDialog('w1:p1', 'Do you want to create other.js?').catch(e => e)
    expect(err.code).toBe('stale_dialog')
  })
})
