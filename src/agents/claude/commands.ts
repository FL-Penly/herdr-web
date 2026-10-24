import { join } from 'node:path'
import { config } from '../../config.ts'
import { isDir, readJsonCached } from '../../lib/fs.ts'
import type { Command } from '../../protocol.ts'
import { builtins, dedupe, scanConfigDir } from '../commands.ts'
import { settingsChain } from './settings.ts'

export const CLAUDE_BUILTINS = [
  ['goal', 'Set a goal and keep working until it is met'],
  ['plan', 'Enter plan mode'],
  ['compact', 'Compact the conversation (optionally with instructions)'],
  ['clear', 'Clear the conversation and start over'],
  ['model', 'Switch the model'],
  ['effort', 'Set the reasoning effort'],
  ['fast', 'Toggle fast mode'],
  ['context', 'Show context usage'],
  ['cost', 'Show the cost of this session'],
  ['usage', 'Show plan usage limits'],
  ['status', 'Show version, model and account status'],
  ['resume', 'Resume a previous conversation'],
  ['fork', 'Fork the conversation from here'],
  ['rename', 'Rename the conversation'],
  ['rewind', 'Rewind to an earlier point'],
  ['loop', 'Run a prompt or command on an interval'],
  ['btw', 'Ask a side question without interrupting'],
  ['review', 'Review a pull request'],
  ['security-review', 'Security review of the pending changes'],
  ['init', 'Create a CLAUDE.md for this project'],
  ['memory', 'Edit memory files'],
  ['permissions', 'Manage tool permissions'],
  ['agents', 'Manage subagents'],
  ['mcp', 'Manage MCP servers'],
  ['hooks', 'Manage hooks'],
  ['plugin', 'Manage plugins'],
  ['skills', 'List skills'],
  ['config', 'Open settings'],
  ['add-dir', 'Add a working directory'],
  ['export', 'Export the conversation'],
  ['copy', 'Copy the last reply'],
  ['todos', 'Show the todo list'],
  ['tasks', 'Show background tasks'],
  ['bashes', 'Show background shells'],
  ['output-style', 'Set the output style'],
  ['theme', 'Change the color theme'],
  ['vim', 'Toggle vim mode'],
  ['doctor', 'Check the installation'],
  ['help', 'Show help'],
  ['login', 'Sign in'],
  ['logout', 'Sign out'],
  ['release-notes', 'Show release notes'],
  ['feedback', 'Send feedback'],
  ['exit', 'Exit Claude Code'],
] as const

interface InstalledPlugin {
  scope?: string
  installPath?: string
  projectPath?: string
}

/** Commands and skills of the plugins enabled for `cwd` (user settings, overridden by project settings). */
function pluginCommands(cwd: string): Command[] {
  const enabled: Record<string, boolean> = {}
  for (const s of settingsChain(cwd).reverse()) Object.assign(enabled, s.enabledPlugins)
  const installed =
    readJsonCached<{ plugins?: Record<string, InstalledPlugin[]> }>(
      join(config.claudeHome, 'plugins', 'installed_plugins.json'),
    )?.plugins ?? {}
  const out: Command[] = []
  for (const [id, on] of Object.entries(enabled)) {
    const installs = installed[id]
    if (!on || !Array.isArray(installs)) continue
    const install =
      installs.find(x => x.scope === 'project' && x.projectPath === cwd) ??
      installs.find(x => x.scope === 'user') ??
      installs[0]
    if (install?.installPath && isDir(install.installPath))
      out.push(...scanConfigDir(install.installPath, 'plugin', `${id.split('@')[0]}:`))
  }
  return out
}

export function claudeCommands(cwd: string): Command[] {
  return dedupe([
    ...builtins(CLAUDE_BUILTINS),
    ...(cwd ? scanConfigDir(join(cwd, '.claude'), 'project') : []),
    ...scanConfigDir(config.claudeHome, 'user'),
    ...pluginCommands(cwd),
  ])
}
