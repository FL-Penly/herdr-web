import DOMPurify from '/vendor/dompurify/dist/purify.es.mjs'
import { marked } from '/vendor/marked/lib/marked.esm.js'
import { isCompactCell, isProseColumn } from './format.js'
import { localRef, looksLikePath } from './paths.js'

// Links in replies must never navigate the single-page app away (drafts and state would be lost), and the opened
// page must not get a handle on this window. A link to a file on this machine (`[a.ts](src/a.ts#L12)`,
// `file:///…`, `notes.txt:3`) opens in the viewer instead, and such a picture is fetched with the token (see
// loadReplyImages). Both are taken before the sanitizer runs: it drops `file:` and `notes.txt:` as unknown schemes.
DOMPurify.addHook('beforeSanitizeAttributes', node => {
  const attr = node.tagName === 'A' ? 'href' : node.tagName === 'IMG' ? 'src' : null
  const value = attr && node.getAttribute(attr)
  if (!value || (attr === 'src' && /^(?:https?|data|blob):/i.test(value))) return
  const file = localRef(value)
  if (!file) return
  node.removeAttribute(attr)
  node.setAttribute(attr === 'href' ? 'data-open-file' : 'data-file-image', file)
})

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName !== 'A') return
  if (node.hasAttribute('data-open-file')) {
    node.setAttribute('role', 'link')
    node.setAttribute('tabindex', '0')
    node.classList.add('file-ref')
  } else if (node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

// Inline code that names a file (`src/a.ts:12`) opens it.
function linkFiles(html) {
  if (!html.includes('<code')) return html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  for (const code of tpl.content.querySelectorAll('code')) {
    if (code.closest('pre, a')) continue
    const text = code.textContent ?? ''
    if (!looksLikePath(text)) continue
    code.classList.add('file-ref')
    code.setAttribute('data-open-file', text.trim())
    code.setAttribute('role', 'link')
    code.setAttribute('tabindex', '0')
  }
  return tpl.innerHTML
}

const CACHE_LIMIT = 400
const cache = new Map()

// A table gets its own sideways scroller, and cells holding a number or a short id never break (a phone
// would otherwise wrap a row number `50` into `5` over `0`).
function shapeTables(html) {
  if (!html.includes('<table')) return html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  for (const table of tpl.content.querySelectorAll('table')) {
    const scroller = document.createElement('div')
    scroller.className = 'table-scroll'
    table.replaceWith(scroller)
    scroller.append(table)
    for (const cell of table.querySelectorAll('th, td')) {
      if (isCompactCell(cell.textContent ?? '')) cell.classList.add('is-compact')
    }
    const columns = Math.max(0, ...[...table.rows].map(r => r.cells.length))
    for (let i = 0; i < columns; i++) {
      const cells = [...table.rows].map(r => r.cells[i]).filter(Boolean)
      if (isProseColumn(cells.map(c => c.textContent ?? ''))) for (const c of cells) c.classList.add('is-prose')
    }
  }
  return tpl.innerHTML
}

/**
 * A reply as plain text, the way it reads on screen: no Markdown marks, list items with their bullet or number.
 * @param {string} text
 */
export function markdownText(text) {
  const box = document.createElement('div')
  box.className = 'markdown'
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px'
  box.innerHTML = markdown(text)
  for (const list of box.querySelectorAll('ol, ul')) {
    let n = Number(list.getAttribute('start') ?? 1)
    for (const item of list.children) {
      if (item.tagName === 'LI') item.prepend(list.tagName === 'OL' ? `${n++}. ` : '• ')
    }
  }
  document.body.append(box)
  const plain = box.innerText
  box.remove()
  return plain.replace(/\n{3,}/g, '\n\n').trim()
}

export function markdown(text) {
  const source = String(text ?? '')
  let html = cache.get(source)
  if (html === undefined) {
    html = linkFiles(shapeTables(DOMPurify.sanitize(marked.parse(source, { breaks: true, gfm: true, async: false }))))
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
    cache.set(source, html)
  }
  return html
}
