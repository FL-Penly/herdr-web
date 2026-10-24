import { sep } from 'node:path'
import { herdr } from '../herdr.ts'
import { TtlCache } from '../lib/cache.ts'
import { mtimeOf } from '../lib/fs.ts'
import type { AgentKind, CodexSession, Command, ModelCatalog, Turn } from '../protocol.ts'
import { lastUserEcho, sameText } from '../tui/screen.ts'
import { claudeCommands } from './claude/commands.ts'
import { claudeProcessSession, findClaudeTranscript } from './claude/locate.ts'
import { claudeModels } from './claude/models.ts'
import { codexCommands, codexSkills } from './codex/commands.ts'
import { codexSessionsRoot } from './codex/config.ts'
import {
  claimedElsewhere,
  followRollout,
  locateCodexRollout,
  paneRollouts,
  pinRollout,
  resumeCandidates,
  resumedRollout,
  rolloutProven,
  shownRollout,
} from './codex/locate.ts'
import { codexModels } from './codex/models.ts'
import { paneClaudePids, paneProcess } from './process.ts'
import { readThread } from './thread.ts'

export { MAX_TURNS, isUnansweredTurn, readThread } from './thread.ts'
export { codexSessionId, setLiveCodexPanes } from './codex/locate.ts'

const RESUME_CHECK_MS = 3_000
/**
 * Rollouts in the pane's folder appended to after its own are few (busy sibling panes). With more, a unique
 * match cannot be shown without reading them all, and the pane keeps its rollout.
 */
const MAX_RESUME_CANDIDATES = 8

/** The transcript file an agent pane is writing: a Claude session's jsonl, or the Codex rollout. */
export async function locateTranscript(v: {
  pane: string
  kind: string
  session: string | null
  cwd: string
}): Promise<string | null> {
  if (v.kind === 'claude') {
    // What the pane's process says it shows wins over herdr's id: herdr keeps the id the process started
    // with, and a process attached to a background job shows the job's session, not its own.
    for (const pid of await paneClaudePids(v.pane)) {
      const session = claudeProcessSession(pid)
      const path = session && findClaudeTranscript(session)
      if (path) return path
    }
    return v.session ? findClaudeTranscript(v.session) : null
  }
  if (v.kind !== 'codex') return null
  const proc = await paneProcess(v.pane)
  const path = locateCodexRollout({ pane: v.pane, cwd: v.cwd, ...proc })
  if (!path) return null
  return rolloutProven(v.pane) ? followResume(v.pane, v.cwd, path) : proveOnScreen(v.pane, v.cwd, path, proc.startedAt)
}

const resumeChecks = new TtlCache<string, true>(RESUME_CHECK_MS, 500)

function newestPrompt(path: string) {
  const user = lastTurn('codex', path)?.user
  return { path, prompt: user?.text ?? null, at: user?.ts ?? 0 }
}

/** The rollout an in-TUI `/resume` moved the pane to, if its screen proves that; else `current`. */
async function followResume(pane: string, cwd: string, current: string): Promise<string> {
  if (resumeChecks.get(pane)) return current
  resumeChecks.set(pane, true)
  const others = resumeCandidates(current, cwd)
  if (!others.length || others.length > MAX_RESUME_CANDIDATES) return current
  const echo = lastUserEcho(await herdr.readScreen(pane).catch(() => ''))
  const resumed = resumedRollout(echo, newestPrompt(current), others.map(newestPrompt))
  if (!resumed || claimedElsewhere(resumed, pane)) return current
  followRollout(pane, resumed)
  return resumed
}

/**
 * A rollout guessed by time (the earliest of the pane's folder since its process started, or a newer one taken
 * for `/new`) may be another Codex's that has closed since. The screen settles it: the one rollout, among those
 * the process may have written, whose newest message is the newest one echoed there. Proven, the pane keeps it.
 */
async function proveOnScreen(pane: string, cwd: string, current: string, startedAt: number): Promise<string> {
  if (resumeChecks.get(pane)) return current
  resumeChecks.set(pane, true)
  const mine = paneRollouts(pane, cwd, startedAt).slice(0, MAX_RESUME_CANDIDATES)
  if (!mine.includes(current)) mine.push(current)
  if (mine.length < 2) return current
  const echo = lastUserEcho(await herdr.readScreen(pane).catch(() => ''))
  const shown = echo?.trim() ? shownRollout(echo, mine.map(newestPrompt)) : null
  if (!shown) return current
  followRollout(pane, shown)
  return shown
}

const PROMPT_PREVIEW = 200
const MAX_CHOICES = 12

/** Conversations a Codex pane may be showing, newest first, for the user to say which one it is. */
export async function codexSessions(pane: string, cwd: string): Promise<CodexSession[]> {
  const proc = await paneProcess(pane)
  const current = locateCodexRollout({ pane, cwd, ...proc })
  const paths = paneRollouts(pane, cwd, proc.startedAt).slice(0, MAX_CHOICES)
  if (current && !paths.includes(current)) paths.unshift(current)
  const echo = lastUserEcho(await herdr.readScreen(pane).catch(() => ''))
  return paths.map(path => {
    const { prompt } = newestPrompt(path)
    return {
      path,
      prompt: prompt?.slice(0, PROMPT_PREVIEW) ?? null,
      at: mtimeOf(path),
      current: path === current,
      onScreen: !!prompt && !!echo?.trim() && sameText(prompt, echo),
    }
  })
}

/** Show `path` for the pane from now on; false when it is not one of the pane's conversations. */
export async function pinCodexSession(pane: string, cwd: string, path: string): Promise<boolean> {
  const proc = await paneProcess(pane)
  const current = locateCodexRollout({ pane, cwd, ...proc })
  if (path !== current && !paneRollouts(pane, cwd, proc.startedAt).includes(path)) return false
  pinRollout(pane, path, { cwd, startedAt: proc.startedAt })
  return true
}

/** The last assistant text of the newest turn; null while the newest user message has no reply yet. */
export function lastReply(kind: AgentKind, path: string): { text: string; at: number } | null {
  const turn = readThread(kind, path, 1).turns[0]
  const steps = turn?.steps ?? []
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step?.type !== 'text') continue
    return { text: step.text, at: step.ts || mtimeOf(path) }
  }
  return null
}

/** The newest turn of a transcript, or null when it has none. */
export function lastTurn(kind: AgentKind, path: string): Turn | null {
  return readThread(kind, path, 1).turns[0] ?? null
}

const commandCache = new TtlCache<string, { commands: Command[]; skills: Command[] }>(30_000, 200)

/** Slash commands for the composer's `/` picker; `skills` are Codex `$skill`s (Claude lists skills as commands). */
export function slashCommands(kind: string, cwd: string): { commands: Command[]; skills: Command[] } {
  const key = `${kind}\0${cwd}`
  const hit = commandCache.get(key)
  if (hit) return hit
  const value =
    kind === 'codex'
      ? { commands: codexCommands(), skills: codexSkills(cwd) }
      : { commands: claudeCommands(cwd), skills: [] }
  return commandCache.set(key, value)
}

export function modelCatalog(kind: string): ModelCatalog {
  return kind === 'codex' ? codexModels() : claudeModels()
}

/** Whether `path` names a rollout file under CODEX_HOME/sessions (used to validate fork marks). */
export function isCodexRollout(path: string): boolean {
  const root = codexSessionsRoot() + sep
  return path.startsWith(root) && path.endsWith('.jsonl') && !path.split(/[\\/]/).includes('..') && !path.includes('\0')
}
