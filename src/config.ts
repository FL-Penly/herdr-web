import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

// The only module under src/ that reads process.env (the quick-fork plugin reads its own fallbacks when it
// runs standalone); the README's configuration table mirrors it.
const env = process.env
const home = env.HOME || homedir()
/** Home as panes report folders (`/proc/<pid>/cwd` is resolved), so `~` shortening works when $HOME is a symlink. */
function realHome(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const list = (v: string | undefined, sep: string) =>
  (v ?? '')
    .split(sep)
    .map(s => s.trim())
    .filter(Boolean)

/** A TCP port from `name`, or `fallback` when unset; anything but an integer 1..65535 is a startup error. */
export function parsePort(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const port = Number(value)
  if (!/^\d+$/.test(value.trim()) || port < 1 || port > 65535)
    throw new Error(`${name} must be an integer from 1 to 65535, not ${JSON.stringify(value)}`)
  return port
}

const configDir = env.HERDR_WEB_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'herdr-web')
const claudeHome = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')

export const config = Object.freeze({
  /** Interface to bind. Loopback by default; set 0.0.0.0 to reach it from other machines. */
  host: env.HERDR_WEB_HOST ?? '127.0.0.1',
  port: parsePort('HERDR_WEB_PORT', env.HERDR_WEB_PORT, 12500),
  /** Access token. Unset: generated once into `<configDir>/token`. `off` disables auth (loopback only). */
  token: env.HERDR_WEB_TOKEN,
  configDir,
  uploadDir: join(env.XDG_RUNTIME_DIR ?? join(env.XDG_CACHE_HOME ?? join(home, '.cache')), 'herdr-web', 'uploads'),
  hiddenWorkspaces: new Set(list(env.HERDR_WEB_HIDE_WORKSPACES, ',')),
  herdrBin: env.HERDR_BIN_PATH ?? 'herdr',
  /** Claude config dirs searched for transcripts: CLAUDE_CONFIG_DIR (or ~/.claude), then HERDR_WEB_CLAUDE_DIRS. */
  claudeHome,
  claudeDirs: [
    claudeHome,
    ...list(env.HERDR_WEB_CLAUDE_DIRS, delimiter).map(d => resolve(d.replace(/^~(?=$|\/)/, home))),
  ],
  claudeEffort: env.CLAUDE_CODE_EFFORT_LEVEL || null,
  codexHome: env.CODEX_HOME ?? join(home, '.codex'),
  agentsHome: join(home, '.agents'),
  home: realHome(home),
  tickMs: 1000,
})
