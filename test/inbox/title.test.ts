import { expect, test } from 'bun:test'
import { cleanTitle } from '../../src/inbox/title.ts'

test.each([
  ['claude', ''],
  ['codex --yolo', ''],
  ['[x] Refactor parser', 'Refactor parser'],
  ['Action Required | Fix tests', 'Fix tests'],
  ['Fix tests | project', 'Fix tests'],
  ['Fix tests | other', 'Fix tests | other'],
  ['  ', ''],
])('cleanTitle(%p)', (raw, expected) => {
  expect(cleanTitle(raw, '/home/alice/project')).toBe(expected)
})
