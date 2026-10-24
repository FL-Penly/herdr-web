import { describe, expect, test } from 'bun:test'
import { findMatches, quoteText } from '../../public/js/find.js'

describe('findMatches', () => {
  test('finds every occurrence, ignoring case', () => {
    expect(findMatches('Error: x\nerror again', 'error')).toEqual([
      [0, 5],
      [9, 14],
    ])
  })

  test('takes the query literally', () => {
    expect(findMatches('a.b axb (c)', 'a.b')).toEqual([[0, 3]])
    expect(findMatches('a.b axb (c)', '(c)')).toEqual([[8, 11]])
  })

  test('stops at the limit and finds nothing for an empty query', () => {
    expect(findMatches('aaaa', 'a', 2)).toHaveLength(2)
    expect(findMatches('aaaa', '')).toEqual([])
  })

  test('matches Chinese text', () => {
    expect(findMatches('构建失败，构建重试', '构建')).toEqual([
      [0, 2],
      [5, 7],
    ])
  })
})

describe('quoteText', () => {
  test('quotes each line and drops trailing blanks', () => {
    expect(quoteText('\n  $ bun test   \n\n  1 fail  \n\n')).toBe('>   $ bun test\n>\n>   1 fail')
  })
})
