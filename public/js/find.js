// @ts-check

/** Past this many matches the rest are not marked: a one-letter search in a long scrollback would stall the page. */
export const MAX_MATCHES = 1000

/**
 * Where `query` occurs in `text`, ignoring case, as [start, end) offsets.
 * @param {string} text
 * @param {string} query
 * @param {number} [limit]
 * @returns {Array<[number, number]>}
 */
export function findMatches(text, query, limit = MAX_MATCHES) {
  if (!query) return []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const found = /** @type {Array<[number, number]>} */ ([])
  for (const m of text.matchAll(pattern)) {
    if (found.length >= limit) break
    found.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  }
  return found
}

/**
 * Text as a quote in a Markdown message: each line behind `> `, trailing blanks dropped.
 * @param {string} text
 */
export function quoteText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n')
}
