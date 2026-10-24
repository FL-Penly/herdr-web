import { join } from 'node:path'
import { config } from '../../config.ts'
import { readJsonCached } from '../../lib/fs.ts'

export interface ClaudeSettings {
  model?: string
  effortLevel?: string
  modelSettings?: Record<string, { effortLevel?: string } | undefined>
  enabledPlugins?: Record<string, boolean>
}

export function userSettings(): ClaudeSettings {
  return readJsonCached<ClaudeSettings>(join(config.claudeHome, 'settings.json')) ?? {}
}

/** Settings files in Claude Code's precedence order: project local, project, user. */
export function settingsChain(cwd: string): ClaudeSettings[] {
  const project = cwd ? [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json')] : []
  return [...project.map(f => readJsonCached<ClaudeSettings>(f) ?? {}), userSettings()]
}

/** The model Claude Code runs when none is chosen; its settings decide the default effort. */
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5[1m]'

/** `claude-opus-5-5[1m]` and `claude-opus-5-5` share their settings. */
export const baseModelId = (model: string) => model.replace(/\[1m\]$/i, '')

/**
 * The effort Claude Code starts `model` (null: the default model) with: the env var, then per settings file
 * (project local, project, user) the per-model effortLevel, then the global one. `cwd: ''` reads user settings only.
 */
export function claudeDefaultEffort(model: string | null, cwd: string): string | null {
  if (config.claudeEffort) return config.claudeEffort
  const id = baseModelId(model || CLAUDE_DEFAULT_MODEL)
  for (const s of settingsChain(cwd)) {
    const effort = s.modelSettings?.[id]?.effortLevel || s.effortLevel
    if (effort) return effort
  }
  return null
}
