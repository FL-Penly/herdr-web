import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserError } from '../../src/server/http.ts'
import { MAX_UPLOAD_BYTES, ensurePrivateDir, pruneUploads, sanitizeName, saveUpload } from '../../src/server/upload.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'herdr-web-upload-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('sanitizeName keeps letters of any script and drops path tricks', () => {
  expect(sanitizeName('shot 1.png')).toBe('shot_1.png')
  expect(sanitizeName('../../etc/passwd')).toBe('passwd')
  expect(sanitizeName('截图 𠀀.png')).toBe('截图_𠀀.png')
  expect(sanitizeName('.bashrc')).toBe('bashrc')
  expect(sanitizeName('$(rm -rf).txt')).toBe('__rm_-rf_.txt')
  expect(sanitizeName(null)).toBe('paste.png')
  expect(sanitizeName('..')).toBe('upload')
  expect(sanitizeName(`${'a'.repeat(200)}.png`)).toHaveLength(80)
})

test('saves into a private dir with a private file', async () => {
  const dir = join(root, 'uploads')
  const req = new Request('http://h/api/upload', { method: 'POST', body: 'hello' })
  const { path } = await saveUpload(req, dir, 'note.txt')
  expect(path.startsWith(`${dir}/`)).toBe(true)
  expect(path.endsWith('-note.txt')).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe('hello')
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('rejects oversized uploads with 413', async () => {
  const req = new Request('http://h/api/upload', {
    method: 'POST',
    body: 'x',
    headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) },
  })
  const err = await saveUpload(req, join(root, 'u'), 'a').catch(e => e)
  expect(err).toBeInstanceOf(UserError)
  expect(err.status).toBe(413)
})

test('tightens an existing dir and refuses a symlinked one', () => {
  const loose = join(root, 'loose')
  mkdirSync(loose, { mode: 0o777 })
  ensurePrivateDir(loose)
  expect(statSync(loose).mode & 0o777).toBe(0o700)
  const link = join(root, 'link')
  symlinkSync(loose, link)
  expect(() => ensurePrivateDir(link)).toThrow(/not a directory/)
})

test('prunes uploads older than a week', () => {
  const dir = join(root, 'p')
  mkdirSync(dir)
  writeFileSync(join(dir, 'old'), '')
  writeFileSync(join(dir, 'new'), '')
  const old = (Date.now() - 8 * 24 * 3600_000) / 1000
  utimesSync(join(dir, 'old'), old, old)
  pruneUploads(dir)
  expect(() => statSync(join(dir, 'old'))).toThrow()
  expect(statSync(join(dir, 'new')).isFile()).toBe(true)
})

test('saveUpload prunes old uploads too', async () => {
  const dir = join(root, 'q')
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(join(dir, 'old'), '')
  const old = (Date.now() - 8 * 24 * 3600_000) / 1000
  utimesSync(join(dir, 'old'), old, old)
  await saveUpload(new Request('http://h/api/upload', { method: 'POST', body: 'x' }), dir, 'a.txt')
  expect(() => statSync(join(dir, 'old'))).toThrow()
})
