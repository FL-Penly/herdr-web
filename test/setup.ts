// Preloaded by bunfig.toml before any test file, and so before src/config.ts reads the environment:
// every home and config dir points into a fresh temp dir, so no test sees the real ~/.claude or ~/.codex.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'herdr-web-test-'))
const dirs = {
  HOME: 'home',
  CLAUDE_CONFIG_DIR: 'home/.claude',
  CODEX_HOME: 'home/.codex',
  HERDR_WEB_CONFIG_DIR: 'config/herdr-web',
  XDG_CONFIG_HOME: 'config',
  XDG_CACHE_HOME: 'cache',
  XDG_RUNTIME_DIR: 'runtime',
}
for (const key of Object.keys(process.env))
  if (key.startsWith('HERDR_WEB_') || key === 'CLAUDE_CODE_EFFORT_LEVEL') delete process.env[key]
for (const [key, rel] of Object.entries(dirs)) {
  const dir = join(root, rel)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  process.env[key] = dir
}
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
