import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MOBILE_QUERY } from '../../public/js/touch.js'

const PUBLIC = join(import.meta.dir, '../../public')
const read = (path: string) => readFileSync(join(PUBLIC, path), 'utf8')

/** The declarations of `selector` inside the `@media` block for `query` (one level of nesting). */
function ruleIn(css: string, query: string, selector: string): string {
  const start = css.indexOf(`@media ${query} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  const block = css.slice(start)
  const rule = block.match(new RegExp(`\\n\\s*${selector.replace('.', '\\.')} \\{([^}]*)\\}`))
  return rule?.[1] ?? ''
}

describe('toasts on a phone', () => {
  test('sit at the top, never over the composer and its Send button', () => {
    const rule = ruleIn(read('css/components/mobile.css'), MOBILE_QUERY, '.toasts')
    expect(rule).toMatch(/\btop:/)
    expect(rule).toMatch(/\bbottom: auto/)
  })

  test('let taps through between them, and each has its own dismiss control', () => {
    expect(read('css/components/feedback.css')).toMatch(/\.toasts \{[^}]*pointer-events: none/)
    expect(read('js/notify.js')).toContain('class="toast-close"')
  })
})

describe('the service worker', () => {
  test('never intercepts requests, so /api and /ws always reach the server', () => {
    const sw = read('sw.js')
    expect(sw).not.toMatch(/addEventListener\(\s*['"]fetch['"]/)
    expect(sw).not.toMatch(/caches\./)
  })
})
