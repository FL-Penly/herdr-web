import { expect, test } from 'bun:test'
import { resolveFile } from '../../src/server/files.ts'

test('a path an agent wrote resolves against home, absolute, or the pane folder', () => {
  expect(resolveFile('~/notes/a.md', '/srv/app', '/home/alice')).toBe('/home/alice/notes/a.md')
  expect(resolveFile('/etc/hosts', '/srv/app', '/home/alice')).toBe('/etc/hosts')
  expect(resolveFile('src/../bench/p95.svg', '/srv/app', '/home/alice')).toBe('/srv/app/bench/p95.svg')
  expect(() => resolveFile('', '/srv/app', '/home/alice')).toThrow()
  expect(() => resolveFile('a\0b', '/srv/app', '/home/alice')).toThrow()
})
