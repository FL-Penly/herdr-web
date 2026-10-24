import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CSP, createStatic, safeJoin } from '../../src/server/static.ts'

let root: string
let statics: ReturnType<typeof createStatic>

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'herdr-web-static-'))
  const put = (path: string, body: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  put('public/index.html', '<!doctype html>')
  put('public/js/main.js', 'export {}')
  put('public/favicon.svg', '<svg/>')
  put('public/notes.txt', 'no mime')
  put('public/.env', 'SECRET=1')
  put('secret.txt', 'outside')
  put('node_modules/marked/lib/marked.esm.js', 'export const marked = 1')
  put('node_modules/@xterm/xterm/css/xterm.css', '.xterm{}')
  put('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2', 'font')
  put('node_modules/left-pad/index.js', 'not allowed')
  statics = createStatic({ publicDir: join(root, 'public'), nodeModules: join(root, 'node_modules') })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('safeJoin', () => {
  test('stays inside the root', () => {
    expect(safeJoin('/srv/public', '/js/a.js')).toBe('/srv/public/js/a.js')
    for (const bad of [
      '/../x',
      '/js/../../x',
      '/%2e%2e/x',
      '/%2e%2e%2fx',
      '/a/..%2f..%2fx',
      '/.git/config',
      '/a%00.js',
      '/a\\..\\x',
      '/',
      '/%E0%A4%A',
    ])
      expect(safeJoin('/srv/public', bad)).toBeNull()
  })
})

describe('pages', () => {
  test('/ serves index.html with the CSP and no-cache', async () => {
    const res = await statics.page('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(CSP)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('ES modules are text/javascript', async () => {
    const res = await statics.page('/js/main.js')
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await res.text()).toBe('export {}')
    expect((await statics.page('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml')
  })

  test('traversal, dotfiles, unknown types and missing files are 404', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/.env', '/notes.txt', '/nope.js', '/js'])
      expect((await statics.page(path)).status).toBe(404)
  })
})

describe('vendor', () => {
  test('serves allowlisted packages, scoped ones included', async () => {
    expect((await statics.vendor('/vendor/marked/lib/marked.esm.js')).status).toBe(200)
    const css = await statics.vendor('/vendor/@xterm/xterm/css/xterm.css')
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(css.headers.get('cache-control')).toContain('max-age')
    const font = await statics.vendor('/vendor/@fontsource/inter/files/inter-latin-400-normal.woff2')
    expect(font.headers.get('content-type')).toBe('font/woff2')
  })

  test('refuses other packages and escapes from the package dir', async () => {
    for (const path of [
      '/vendor/left-pad/index.js',
      '/vendor/marked/../left-pad/index.js',
      '/vendor/marked/%2e%2e/left-pad/index.js',
      '/vendor/@xterm/xterm/../../left-pad/index.js',
      '/vendor/@xterm/xtermx/css/xterm.css',
      '/vendor/marked',
    ])
      expect((await statics.vendor(path)).status).toBe(404)
  })
})
