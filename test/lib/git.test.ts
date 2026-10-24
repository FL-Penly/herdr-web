import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_NEW_FILE, newFilePatch, parseNumstat, workingTreeDiff } from '../../src/lib/git.ts'

test('a new text file becomes a git-style patch of additions', () => {
  const { file, patch } = newFilePatch('cli.js', { kind: 'text', text: 'one\ntwo\n' })
  expect(file).toEqual({ path: 'cli.js', added: 2, removed: 0, untracked: true })
  expect(patch).toBe(
    'diff --git a/cli.js b/cli.js\nnew file mode 100644\n--- /dev/null\n+++ b/cli.js\n@@ -0,0 +1,2 @@\n+one\n+two\n',
  )
})

test('a missing final newline is marked as git does', () => {
  const { file, patch } = newFilePatch('a', { kind: 'text', text: 'x' })
  expect(file.added).toBe(1)
  expect(patch.endsWith('@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of file\n')).toBe(true)
})

test('binary, large, empty and unreadable files', () => {
  const bin = newFilePatch('img.png', { kind: 'binary' })
  expect(bin.file.binary).toBe(true)
  expect(bin.patch).toContain('Binary files /dev/null and b/img.png differ')
  const big = newFilePatch('big.log', { kind: 'large', size: MAX_NEW_FILE + 1 })
  expect(big.file.added).toBe(0)
  expect(big.patch).toBe(
    'diff --git a/big.log b/big.log\nnew file mode 100644\n--- /dev/null\n+++ b/big.log\n(file too large to show)\n',
  )
  expect(newFilePatch('empty', { kind: 'text', text: '' }).patch).toBe(
    'diff --git a/empty b/empty\nnew file mode 100644\n',
  )
  expect(newFilePatch('gone', null)).toEqual({
    file: { path: 'gone', added: 0, removed: 0, untracked: true },
    patch: '',
  })
})

test('parseNumstat reads plain and renamed entries', () => {
  expect(parseNumstat('3\t1\ta.ts\0-\t-\tlogo.png\0' + '2\t0\t\0old.ts\0new.ts\0')).toEqual([
    { path: 'a.ts', added: 3, removed: 1 },
    { path: 'logo.png', added: 0, removed: 0 },
    { path: 'new.ts', added: 2, removed: 0 },
  ])
})

async function sh(cwd: string, ...cmd: string[]) {
  const p = Bun.spawn(cmd, { cwd, stdout: 'ignore', stderr: 'ignore' })
  expect(await p.exited).toBe(0)
}

test('workingTreeDiff includes untracked files in the patch and the totals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-web-git-'))
  await sh(dir, 'git', 'init', '-q')
  await sh(dir, 'git', 'config', 'user.email', 't@example.com')
  await sh(dir, 'git', 'config', 'user.name', 't')
  writeFileSync(join(dir, 'README.md'), '# a\n')
  await sh(dir, 'git', 'add', '.')
  await sh(dir, 'git', 'commit', '-qm', 'init')
  writeFileSync(join(dir, 'README.md'), '# b\n')
  writeFileSync(join(dir, 'cli.js'), 'a\nb\nc\n')
  writeFileSync(join(dir, '名前.txt'), 'x\n')
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]))
  writeFileSync(join(dir, 'huge.txt'), 'y\n'.repeat(MAX_NEW_FILE))

  const d = await workingTreeDiff(dir)
  expect(d).not.toBeNull()
  if (!d) return
  const byPath = Object.fromEntries(d.files.map(f => [f.path, f]))
  expect(byPath['README.md']).toEqual({ path: 'README.md', added: 1, removed: 1 })
  expect(byPath['cli.js']).toEqual({ path: 'cli.js', added: 3, removed: 0, untracked: true })
  expect(byPath['名前.txt']?.added).toBe(1)
  expect(byPath['blob.bin']?.binary).toBe(true)
  expect(byPath['huge.txt']?.added).toBe(0)
  expect(d.added).toBe(5)
  expect(d.removed).toBe(1)
  expect(d.diff.indexOf('diff --git a/README.md')).toBe(0)
  expect(d.diff).toContain(
    'diff --git a/cli.js b/cli.js\nnew file mode 100644\n--- /dev/null\n+++ b/cli.js\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n',
  )
  expect(d.diff).toContain('+++ b/名前.txt\n')
  expect(d.diff).toContain('+++ b/huge.txt\n(file too large to show)\n')
})
