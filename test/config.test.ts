import { expect, test } from 'bun:test'
import { parsePort } from '../src/config.ts'

test('parsePort: unset falls back, anything but 1..65535 is refused by name', () => {
  expect(parsePort('HERDR_WEB_PORT', undefined, 12500)).toBe(12500)
  expect(parsePort('HERDR_WEB_PORT', '', 12500)).toBe(12500)
  expect(parsePort('HERDR_WEB_PORT', '8080', 12500)).toBe(8080)
  for (const bad of ['0', '65536', '80.5', 'abc', '-1', '1e3'])
    expect(() => parsePort('HERDR_WEB_PORT', bad, 12500)).toThrow(/HERDR_WEB_PORT must be an integer/)
})
