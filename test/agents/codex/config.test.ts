import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexConfigFrom, parseTomlStrings, readCodexConfig } from '../../../src/agents/codex/config.ts'

const TOML = `
model = "gpt-top" # comment
model_reasoning_effort = 'high'
notes = """
[profiles.fake]
model_reasoning_effort = "low"
"""

[model_providers.proxy]
name = "Proxy"
model = "not-top-level"

[profiles.fast]
model = "gpt-fast"
model_reasoning_effort = "minimal"

[profiles."deep work"]
model_reasoning_effort = "xhigh"
`

test('top-level keys only, ignoring tables and multi-line strings', () => {
  expect(codexConfigFrom(TOML)).toEqual({ model: 'gpt-top', effort: 'high' })
  expect(parseTomlStrings(TOML).get('model_providers.proxy')).toEqual({ name: 'Proxy', model: 'not-top-level' })
})

test('the active profile overrides the top level', () => {
  expect(codexConfigFrom(`profile = "fast"\n${TOML}`)).toEqual({
    model: 'gpt-fast',
    effort: 'minimal',
    profile: 'fast',
  })
  expect(codexConfigFrom(`profile = "deep work"\n${TOML}`)).toEqual({
    model: 'gpt-top',
    effort: 'xhigh',
    profile: 'deep work',
  })
})

const dir = mkdtempSync(join(tmpdir(), 'codex-config-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('readCodexConfig re-reads when the file changes, and tolerates a missing file', () => {
  const path = join(dir, 'config.toml')
  expect(readCodexConfig(path)).toEqual({})
  writeFileSync(path, 'model = "a"\n')
  expect(readCodexConfig(path).model).toBe('a')
  writeFileSync(path, 'model = "bb"\n')
  utimesSync(path, new Date(), new Date(Date.now() + 5000))
  expect(readCodexConfig(path).model).toBe('bb')
})
