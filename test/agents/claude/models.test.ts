import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_EFFORTS, CLAUDE_MODELS, claudeModels } from '../../../src/agents/claude/models.ts'
import { config } from '../../../src/config.ts'

// test/setup.ts points CLAUDE_CONFIG_DIR at a temp dir, so this is the only user settings file.
const settings = join(config.claudeHome, 'settings.json')
afterEach(() => rmSync(settings, { force: true }))

test('the Claude catalog: default entry first, every model with the effort list', () => {
  const catalog = claudeModels()
  expect(catalog.models[0]?.id).toBe('')
  expect(catalog.models.map(m => m.id)).toEqual(CLAUDE_MODELS.map(m => m.id))
  for (const m of catalog.models) expect(m.efforts).toEqual(CLAUDE_EFFORTS)
})

test('without user settings: no default model or effort', () => {
  expect(claudeModels().default).toEqual({ model: '', effort: '' })
})

test('user settings decide the default model, its effort and per-model efforts', () => {
  mkdirSync(config.claudeHome, { recursive: true })
  writeFileSync(
    settings,
    JSON.stringify({
      model: 'sonnet',
      effortLevel: 'high',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'max' } },
    }),
  )
  const catalog = claudeModels()
  expect(catalog.default).toEqual({ model: 'sonnet', effort: 'high' })
  expect(catalog.models.find(m => m.id === 'claude-opus-5-5[1m]')?.effort).toBe('max')
  expect(catalog.models.find(m => m.id === 'sonnet')?.effort).toBeUndefined()
})

test('no model set: the default model (Opus 5.5) and its per-model effort apply', () => {
  mkdirSync(config.claudeHome, { recursive: true })
  writeFileSync(
    settings,
    JSON.stringify({ effortLevel: 'low', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }),
  )
  expect(claudeModels().default).toEqual({ model: '', effort: 'xhigh' })
})
