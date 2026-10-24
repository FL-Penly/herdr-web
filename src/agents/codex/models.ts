import { join } from 'node:path'
import { config } from '../../config.ts'
import { readJsonCached } from '../../lib/fs.ts'
import type { Model, ModelCatalog } from '../../protocol.ts'
import { readCodexConfig } from './config.ts'

interface CachedModel {
  slug?: string
  display_name?: string
  visibility?: string
  supported_reasoning_levels?: ({ effort?: string } | string)[]
}

/**
 * Models Codex lists in its picker, from the `models_cache.json` it keeps in CODEX_HOME. Codex writes that file
 * the first time it runs; until then the model configured in config.toml is the only choice, and `unavailable`
 * says why the list is short.
 */
export function codexModels(): ModelCatalog {
  const cache = readJsonCached<{ models?: CachedModel[] }>(join(config.codexHome, 'models_cache.json'))
  const { model = '', effort = '' } = readCodexConfig()
  const models = modelsFromCache(cache?.models ?? [])
  if (models.length) return { models, default: { model, effort } }
  const configured: Model[] = model
    ? [{ id: model, label: model, efforts: effort ? [effort] : [], ...(effort ? { effort } : {}) }]
    : []
  return { models: configured, default: { model, effort }, unavailable: 'no_cache' }
}

export function modelsFromCache(list: CachedModel[]): Model[] {
  const seen = new Set<string>()
  const models: Model[] = []
  for (const m of list) {
    // Slugs with a '/' are provider-routed duplicates of a plain slug.
    if (!m.slug || m.slug.includes('/') || m.visibility === 'hide' || seen.has(m.slug)) continue
    seen.add(m.slug)
    const efforts = (m.supported_reasoning_levels ?? [])
      .map(x => (typeof x === 'string' ? x : x?.effort))
      .filter((e): e is string => !!e)
    models.push({ id: m.slug, label: m.display_name ?? m.slug, efforts })
  }
  return models
}
