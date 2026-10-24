import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { config } from '../src/config.ts'

test('tests never see the real home: test/setup.ts redirects every config dir', () => {
  const dirs = [process.env.HOME, config.home, config.claudeHome, config.codexHome, config.configDir, config.uploadDir]
  for (const dir of dirs) expect(dir?.startsWith(tmpdir())).toBe(true)
  expect(config.claudeDirs).toEqual([config.claudeHome])
  expect(config.claudeEffort).toBeNull()
  expect(config.token).toBeUndefined()
})
