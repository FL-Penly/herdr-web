import { describe, expect, test } from 'bun:test'
import { parseFrontmatter } from '../../src/lib/frontmatter.ts'

describe('parseFrontmatter', () => {
  test('plain keys and body', () => {
    const fm = parseFrontmatter('---\nname: review\ndescription: Review a change\n---\n# Review\nbody')
    expect(fm.data).toEqual({ name: 'review', description: 'Review a change' })
    expect(fm.body).toBe('# Review\nbody')
  })

  test('CRLF line endings', () => {
    const fm = parseFrontmatter('---\r\nname: x\r\ndescription: Works on Windows\r\n---\r\nbody\r\n')
    expect(fm.data).toEqual({ name: 'x', description: 'Works on Windows' })
    expect(fm.body).toBe('body\n')
  })

  test('quotes are stripped only as a matched pair', () => {
    const fm = parseFrontmatter(
      `---\na: "double \\"quoted\\""\nb: 'single ''quoted'''\nc: "unmatched\nd: it's fine\n---\n`,
    )
    expect(fm.data).toEqual({ a: 'double "quoted"', b: "single 'quoted'", c: '"unmatched', d: "it's fine" })
  })

  test('folded block scalar', () => {
    const fm = parseFrontmatter(
      '---\nname: x\ndescription: >\n  Use when a composition needs\n  keyframes.\n\n  Not for captions.\nother: y\n---\n',
    )
    expect(fm.data.description).toBe('Use when a composition needs keyframes.\nNot for captions.')
    expect(fm.data.other).toBe('y')
  })

  test('literal block scalar with strip indicator', () => {
    const fm = parseFrontmatter('---\ndescription: |-\n  line one\n    indented\n  line three\n---\n')
    expect(fm.data.description).toBe('line one\n  indented\nline three')
  })

  test('chomping indicators are accepted; a block never ends in a newline', () => {
    const fm = parseFrontmatter('---\na: |+\n  keep\n\nb: >-\n  strip\n---\n')
    expect(fm.data).toEqual({ a: 'keep', b: 'strip' })
  })

  test('multi-line plain scalar and trailing comment', () => {
    const fm = parseFrontmatter('---\ndescription: Starts here\n  and continues\nname: x # a comment\n---\n')
    expect(fm.data).toEqual({ description: 'Starts here and continues', name: 'x' })
  })

  test('nested mappings and lists are skipped', () => {
    const fm = parseFrontmatter('---\nmetadata:\n  owner: alice\ntags:\n  - a\ndescription: d\n---\n')
    expect(fm.data).toEqual({ description: 'd' })
  })

  test('no frontmatter: the whole text is the body', () => {
    expect(parseFrontmatter('# Title\ntext')).toEqual({ data: {}, body: '# Title\ntext' })
    expect(parseFrontmatter('---\nunterminated: yes')).toEqual({ data: {}, body: '---\nunterminated: yes' })
  })
})
