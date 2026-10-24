import { afterAll, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexModels, modelsFromCache } from '../../../src/agents/codex/models.ts'
import { config } from '../../../src/config.ts'

const configToml = join(config.codexHome, 'config.toml')
const cacheJson = join(config.codexHome, 'models_cache.json')
afterAll(() => {
  rmSync(configToml, { force: true })
  rmSync(cacheJson, { force: true })
})

test('models_cache.json: hidden and provider-routed slugs dropped, efforts flattened', () => {
  expect(
    modelsFromCache([
      { slug: 't-pl/gpt-x', display_name: 'GPT X' },
      { slug: 'gpt-x', display_name: 'GPT X', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'gpt-x', display_name: 'dup' },
      { slug: 'gpt-hidden', visibility: 'hide' },
      { slug: 'gpt-y', supported_reasoning_levels: ['medium'] },
    ]),
  ).toEqual([
    { id: 'gpt-x', label: 'GPT X', efforts: ['low', 'high'] },
    { id: 'gpt-y', label: 'gpt-y', efforts: ['medium'] },
  ])
})

test('before Codex wrote its model cache, the configured model is the one choice and the catalog says why', () => {
  expect(codexModels()).toEqual({ models: [], default: { model: '', effort: '' }, unavailable: 'no_cache' })
  writeFileSync(configToml, 'model = "gpt-conf"\nmodel_reasoning_effort = "high"\n')
  expect(codexModels()).toEqual({
    models: [{ id: 'gpt-conf', label: 'gpt-conf', efforts: ['high'], effort: 'high' }],
    default: { model: 'gpt-conf', effort: 'high' },
    unavailable: 'no_cache',
  })
  // Picked up once Codex has run, without a restart.
  writeFileSync(
    cacheJson,
    JSON.stringify({ models: [{ slug: 'gpt-conf', display_name: 'GPT Conf' }, { slug: 'gpt-z' }] }),
  )
  expect(codexModels()).toEqual({
    models: [
      { id: 'gpt-conf', label: 'GPT Conf', efforts: [] },
      { id: 'gpt-z', label: 'gpt-z', efforts: [] },
    ],
    default: { model: 'gpt-conf', effort: 'high' },
  })
})
