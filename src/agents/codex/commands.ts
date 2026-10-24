import { join } from 'node:path'
import { config } from '../../config.ts'
import type { Command } from '../../protocol.ts'
import { builtins, dedupe, markdownCommands, skillsIn } from '../commands.ts'

export const CODEX_BUILTINS = [
  ['goal', 'Set or show the goal of a long task'],
  ['plan', 'Switch to plan mode'],
  ['model', 'Choose the model and reasoning effort'],
  ['permissions', 'Choose what Codex is allowed to do'],
  ['review', 'Review the current changes'],
  ['new', 'Start a new conversation in this session'],
  ['resume', 'Resume a previous conversation'],
  ['fork', 'Fork the current conversation'],
  ['side', 'Start a side conversation in a temporary fork'],
  ['compact', 'Summarize the conversation to free up context'],
  ['diff', 'Show the git diff, including untracked files'],
  ['mention', 'Mention a file'],
  ['status', 'Show the session configuration and token usage'],
  ['usage', 'Show usage limits'],
  ['init', 'Create an AGENTS.md for this project'],
  ['skills', 'Use a skill'],
  ['prompts', 'Run or save a reusable prompt'],
  ['rename', 'Rename the conversation'],
  ['copy', 'Copy the last reply'],
  ['export', 'Export the conversation as Markdown'],
  ['mcp', 'List MCP tools'],
  ['plugins', 'Browse plugins'],
  ['hooks', 'Manage hooks'],
  ['memory', 'Memory settings'],
  ['experimental', 'Toggle experimental features'],
  ['cd', 'Change the working directory'],
  ['pwd', 'Show the working directory'],
  ['ps', 'List background terminals'],
  ['clear', 'Clear the screen and start a new conversation'],
  ['logout', 'Sign out'],
  ['quit', 'Exit Codex'],
] as const

export function codexCommands(): Command[] {
  // Saved prompts (`$CODEX_HOME/prompts/*.md`, not nested) are invoked as `/prompts:<name>`.
  const prompts = markdownCommands(join(config.codexHome, 'prompts'), 'user', 'prompts:', 0)
  return dedupe([...builtins(CODEX_BUILTINS), ...prompts])
}

/** Skills Codex offers as `$name`: user skills (CODEX_HOME, ~/.agents), then the project's. */
export function codexSkills(cwd: string): Command[] {
  return dedupe([
    ...skillsIn(join(config.codexHome, 'skills'), 'user'),
    ...skillsIn(join(config.agentsHome, 'skills'), 'user'),
    ...(cwd
      ? [...skillsIn(join(cwd, '.codex', 'skills'), 'project'), ...skillsIn(join(cwd, '.agents', 'skills'), 'project')]
      : []),
  ])
}
