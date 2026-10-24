import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const manifest = Bun.TOML.parse(readFileSync(join(root, 'plugin/quick-fork/herdr-plugin.toml'), 'utf8')) as {
  id: string
  version: string
  platforms: string[]
  actions: { id: string; command: string[] }[]
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('the plugin version follows package.json', () => {
  expect(manifest.version).toBe(pkg.version)
})

test('every action runs fork.ts with bun in its own mode', () => {
  expect(manifest.actions.map(a => a.id)).toEqual(['right', 'down', 'tab'])
  for (const a of manifest.actions) expect(a.command).toEqual(['bun', 'fork.ts', a.id])
  expect(manifest.platforms).toEqual(['linux', 'macos'])
})

test('fork.ts is self-contained: node and bun builtins only', () => {
  const src = readFileSync(join(root, 'plugin/quick-fork/fork.ts'), 'utf8')
  const specifiers = [...src.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])
  expect(specifiers.length).toBeGreaterThan(0)
  for (const s of specifiers) expect(s).toMatch(/^(node:|bun$)/)
})
