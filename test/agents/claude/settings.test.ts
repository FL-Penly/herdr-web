import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseModelId, claudeDefaultEffort } from '../../../src/agents/claude/settings.ts'

const cwd = mkdtempSync(join(tmpdir(), 'claude-project-'))
afterAll(() => rmSync(cwd, { recursive: true, force: true }))

test('project settings decide the effort, per model first', () => {
  mkdirSync(join(cwd, '.claude'))
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'low' }))
  writeFileSync(
    join(cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'max' } } }),
  )
  expect(claudeDefaultEffort('claude-opus-5-5[1m]', cwd)).toBe('max')
  expect(claudeDefaultEffort('claude-haiku', cwd)).toBe('low')
  // No model yet: Claude Code runs the default model (Opus 5.5), so its per-model setting applies.
  expect(claudeDefaultEffort(null, cwd)).toBe('max')
})

test('baseModelId drops the 1M suffix', () => {
  expect(baseModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
  expect(baseModelId('sonnet')).toBe('sonnet')
})
