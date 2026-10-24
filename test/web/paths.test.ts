import { describe, expect, test } from 'bun:test'
import { PATH_IN_TEXT, localRef, looksLikePath, splitLocation } from '../../public/js/paths.js'

describe('paths', () => {
  test('a reference names a file and maybe a line', () => {
    expect(splitLocation('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitLocation('src/a.ts:12:4')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitLocation('src/a.ts#L7-L9')).toEqual({ path: 'src/a.ts', line: 7 })
    expect(splitLocation('~/notes.md')).toEqual({ path: '~/notes.md', line: null })
  })

  test('paths as agents write them, and what only looks like one', () => {
    for (const s of ['src/server.ts', 'bench/p95.svg', './a.md', '~/x/y.txt', '/etc/hosts', 'package.json', 'a.ts:3'])
      expect(looksLikePath(s)).toBe(true)
    for (const s of ['1.2.3', 'e.g.', 'github.com', 'https://x.dev/a.md', 'foo()', 'two words.md', 'src/server', ''])
      expect(looksLikePath(s)).toBe(false)
  })

  test('paths inside a line of terminal text', () => {
    const line = '  Wrote bench/p95.svg and updated src/server.ts:42, see README.md.'
    expect([...line.matchAll(PATH_IN_TEXT)].map(m => m[0].replace(/[.,;:]+$/, ''))).toEqual([
      'bench/p95.svg',
      'src/server.ts:42',
      'README.md',
    ])
  })
})

describe('localRef', () => {
  test('a link to a file: any name, decoded', () => {
    expect(localRef('my%20file.txt')).toBe('my file.txt')
    expect(localRef('%E4%B8%AD%E6%96%87%20%E5%9B%BE.png')).toBe('中文 图.png')
    expect(localRef('docs/guide')).toBe('docs/guide')
    expect(localRef('src/a.ts#L12')).toBe('src/a.ts#L12')
    expect(localRef('/abs/x.md')).toBe('/abs/x.md')
  })

  test('file URLs and a name with its line', () => {
    expect(localRef('file:///home/a/x.png')).toBe('/home/a/x.png')
    expect(localRef('file://localhost/tmp/y')).toBe('/tmp/y')
    expect(localRef('sample.txt:2')).toBe('sample.txt:2')
    expect(localRef('src/a.ts:12:4')).toBe('src/a.ts:12:4')
  })

  test('not web addresses, other schemes or anchors', () => {
    for (const href of [
      'https://x.dev/a.ts',
      'mailto:a@b.c',
      'javascript:alert(1)',
      'data:text/html,x',
      '#top',
      '//cdn/x.js',
      '?q=1',
      '',
    ])
      expect(localRef(href)).toBeNull()
  })
})
