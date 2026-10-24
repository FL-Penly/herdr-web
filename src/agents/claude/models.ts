import { join } from 'node:path'
import { config } from '../../config.ts'
import { readJsonCached } from '../../lib/fs.ts'
import type { Model, ModelCatalog } from '../../protocol.ts'
import { CLAUDE_DEFAULT_MODEL, baseModelId, claudeDefaultEffort, userSettings } from './settings.ts'

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** `id: ''` starts Claude Code without `--model`. Override with `claude` in `<configDir>/models.json`. */
export const CLAUDE_MODELS: readonly { id: string; label: string }[] = [
  { id: '', label: 'Default (Opus 5.5 1M)' },
  { id: 'claude-opus-5-5[1m]', label: 'Opus 5.5 (1M)' },
  { id: 'claude-fable-5-1[1m]', label: 'Fable 5.1 (1M)' },
  { id: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'haiku', label: 'Haiku 5.5' },
  { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)' },
]

function catalogEntries(): readonly { id: string; label: string }[] {
  const custom = readJsonCached<{ claude?: unknown }>(join(config.configDir, 'models.json'))?.claude
  if (!Array.isArray(custom)) return CLAUDE_MODELS
  const valid = custom.filter(m => typeof m?.id === 'string' && typeof m?.label === 'string')
  return valid.length ? valid.map(m => ({ id: m.id, label: m.label })) : CLAUDE_MODELS
}

export function claudeModels(): ModelCatalog {
  const st = userSettings()
  const models: Model[] = catalogEntries().map(({ id, label }) => {
    const effort = id ? st.modelSettings?.[baseModelId(id)]?.effortLevel : undefined
    return { id, label, efforts: CLAUDE_EFFORTS, ...(effort ? { effort } : {}) }
  })
  // The picker opens outside any project, so the default is what user settings (and the env) give.
  const effort = claudeDefaultEffort(st.model || CLAUDE_DEFAULT_MODEL, '') ?? ''
  return { models, default: { model: st.model ?? '', effort } }
}
