import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_RECENT_DIRS, RecentDirs, completeDirs, dirChoices, isDir } from '../../src/server/dirs.ts'

test('dirChoices: pane folders, then recent, then home; deduped, existing only', () => {
  const exists = (p: string) => !p.includes('gone')
  expect(
    dirChoices(
      { paneCwds: ['/w/a', '/w/b/', '/w/a', '', '/w/gone'], recent: ['/r/x', '/w/b', 'relative'], home: '/home/u' },
      exists,
    ),
  ).toEqual({ recent: ['/w/a', '/w/b', '/r/x', '/home/u'], home: '/home/u' })
})

test('RecentDirs keeps the newest first, at most twelve, across restarts', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'herdr-web-dirs-')), 'sub', 'dirs.json')
  const dirs = new RecentDirs(file)
  expect(dirs.list()).toEqual([])
  for (let i = 0; i < MAX_RECENT_DIRS + 3; i++) dirs.record(`/d/${i}`)
  dirs.record('/d/5/')
  const again = new RecentDirs(file)
  expect(again.list()[0]).toBe('/d/5')
  expect(again.list()).toHaveLength(MAX_RECENT_DIRS)
  expect(again.list().filter(d => d === '/d/5')).toHaveLength(1)
  writeFileSync(file, '{oops')
  expect(new RecentDirs(file).list()).toEqual([])
})

test('completeDirs matches the last segment; hidden only for a leading dot; ~ is home', () => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-web-complete-'))
  for (const d of ['herdr', 'herdr-web', 'Hello', '.hidden', 'other']) mkdirSync(join(root, d))
  writeFileSync(join(root, 'here.txt'), '')
  symlinkSync(join(root, 'other'), join(root, 'here-link'))
  expect(completeDirs(`${root}/he`, '/nowhere')).toEqual([
    `${root}/herdr`,
    `${root}/herdr-web`,
    `${root}/here-link`,
    `${root}/Hello`,
  ])
  expect(completeDirs(`${root}/`, '/nowhere')).not.toContain(`${root}/.hidden`)
  expect(completeDirs(`${root}/.h`, '/nowhere')).toEqual([`${root}/.hidden`])
  expect(completeDirs('~/herd', root)).toEqual([`${root}/herdr`, `${root}/herdr-web`])
  expect(completeDirs('~', root)).toEqual([root])
  expect(completeDirs('relative', root)).toEqual([])
  expect(completeDirs(`${root}/missing/x`, root)).toEqual([])
  expect(isDir(root)).toBe(true)
  expect(isDir(join(root, 'here.txt'))).toBe(false)
})
