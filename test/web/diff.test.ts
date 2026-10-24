import { describe, expect, test } from 'bun:test'
import { diffLineClass, diffRows, diffSignature, patchFor, samePath, splitDiff } from '../../public/js/diff.js'

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export { a }
\\ No newline at end of file
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1 @@
+# Title
`

describe('splitDiff', () => {
  test('splits per file and drops headers', () => {
    const files = splitDiff(DIFF)
    expect(files.map(f => f.path)).toEqual(['src/app.ts', 'docs/new.md'])
    expect(files[0].lines[0]).toBe('@@ -1,3 +1,4 @@')
    expect(files[0].lines).not.toContain('--- a/src/app.ts')
    expect(files[1].lines).toEqual(['@@ -0,0 +1 @@', '+# Title', ''])
  })

  test('takes the new path, unquoting what git quotes', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git "a/\\346\\226\\207.md" "b/\\346\\226\\207.md"',
      '--- "a/\\346\\226\\207.md"',
      '+++ "b/\\346\\226\\207.md"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '--- not a header',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n')
    const files = splitDiff(diff)
    expect(files.map(f => f.path)).toEqual(['new.ts', '文.md', 'gone.ts', 'logo.png'])
    expect(files[0].lines).toEqual(['@@ -1 +1 @@', '-a', '+b'])
    expect(files[2].lines).toEqual(['@@ -1 +0,0 @@', '--- not a header'])
    expect(files[3].lines).toEqual(['Binary files a/logo.png and b/logo.png differ'])
  })

  test('empty input', () => {
    expect(splitDiff('')).toEqual([])
  })
})

describe('diffRows', () => {
  test('numbers lines by the new file and skips deleted ones', () => {
    const rows = diffRows(splitDiff(DIFF)[0].lines)
    expect(rows).toEqual([
      { type: 'hunk', text: '@@ -1,3 +1,4 @@' },
      { type: 'ctx', text: ' const a = 1', line: 1 },
      { type: 'del', text: '-const b = 2', line: null },
      { type: 'add', text: '+const b = 3', line: 2 },
      { type: 'add', text: '+const c = 4', line: 3 },
      { type: 'ctx', text: ' export { a }', line: 4 },
    ])
  })
})

describe('diffLineClass', () => {
  test('classifies changed lines but not file headers', () => {
    expect(diffLineClass('+added')).toBe('add')
    expect(diffLineClass('-removed')).toBe('del')
    expect(diffLineClass('+++ b/file')).toBe('')
    expect(diffLineClass('--- a/file')).toBe('')
    expect(diffLineClass(' context')).toBe('')
  })
})

describe('samePath', () => {
  test('matches relative and absolute forms of the same file', () => {
    expect(samePath('src/app.ts', 'src/app.ts')).toBe(true)
    expect(samePath('/home/alice/project/src/app.ts', 'src/app.ts')).toBe(true)
    expect(samePath('src/app.ts', '/home/alice/project/src/app.ts')).toBe(true)
  })

  test('rejects different files and empty values', () => {
    expect(samePath('src/app.ts', 'lib/app.ts')).toBe(false)
    expect(samePath('xapp.ts', 'app.ts')).toBe(false)
    expect(samePath('', 'app.ts')).toBe(false)
    expect(samePath(null, null)).toBe(false)
  })
})

describe('review of new files', () => {
  const NEW = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
diff --git a/cli.js b/cli.js
new file mode 100644
--- /dev/null
+++ b/cli.js
@@ -0,0 +1,2 @@
+#!/usr/bin/env node
+console.log('hi')
diff --git a/big.json b/big.json
new file mode 100644
(file too large to show)
`

  test('a picked file gets its own patch, a new file all of it as additions', () => {
    const files = splitDiff(NEW)
    const cli = patchFor(files, 'cli.js')
    expect(cli?.path).toBe('cli.js')
    expect(diffRows(cli?.lines ?? []).map(r => r.type)).toEqual(['hunk', 'add', 'add'])
    expect(diffRows(cli?.lines ?? []).map(r => ('line' in r ? r.line : null))).toEqual([null, 1, 2])
  })

  test('never another file: a path the diff lacks or matches ambiguously gives null', () => {
    const files = [
      { path: 'src/cli.js', lines: [] },
      { path: 'test/cli.js', lines: [] },
    ]
    expect(patchFor(files, 'cli.js')).toBeNull()
    expect(patchFor(files, 'test/cli.js')?.path).toBe('test/cli.js')
    expect(patchFor(splitDiff(NEW), 'missing.js')).toBeNull()
    expect(patchFor([{ path: 'pkg/src/a.ts', lines: [] }], 'src/a.ts')?.path).toBe('pkg/src/a.ts')
  })

  test('a stub without hunks is a note, not a numbered line', () => {
    const big = patchFor(splitDiff(NEW), 'big.json')
    expect(diffRows(big?.lines ?? [])).toEqual([{ type: 'note', text: '(file too large to show)' }])
  })
})

describe('diffSignature', () => {
  const patch = (status: string) =>
    `diff --git a/routes.js b/routes.js\nnew file mode 100644\n--- /dev/null\n+++ b/routes.js\n@@ -0,0 +1,3 @@\n+function health(req, res) {\n+  json(res, 200, { status: '${status}' });\n+}\n`
  const files = [{ path: 'routes.js', added: 3, removed: 0, untracked: true }]

  test('an equal-length substitution changes it', () => {
    const before = { files, diff: patch('ok') }
    const after = { files: files.map(f => ({ ...f })), diff: patch('up') }
    expect(after.diff.length).toBe(before.diff.length)
    expect(diffSignature(after)).not.toBe(diffSignature(before))
  })

  test('the same content keeps it', () => {
    expect(diffSignature({ files, diff: patch('ok') })).toBe(
      diffSignature({ files: structuredClone(files), diff: patch('ok') }),
    )
  })

  test('a changed count changes it', () => {
    const more = [{ ...files[0], added: 4 }]
    expect(diffSignature({ files: more, diff: '' })).not.toBe(diffSignature({ files, diff: '' }))
  })
})
