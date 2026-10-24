// @ts-check
import { fetchFile } from './api.js'
import { copyText, esc, icon } from './dom.js'
import { t } from './i18n/index.js'
import { markdown } from './markdown.js'
import { toast } from './notify.js'
import { splitLocation } from './paths.js'
import { state } from './state.js'

// Text past this is offered as a download: a phone renders a few MB of rows slowly.
const TEXT_LIMIT = 2 << 20
const NUMBERED_LINES = 20_000
const ZOOM_STEP = 1.25
const TEXT_TYPE = /^(?:text\/|application\/(?:json|javascript|xml|x-sh|toml|yaml|x-yaml|sql|typescript|graphql))/
const MARKDOWN = /\.(?:md|markdown|mdx)$/i
/**
 * What to show a file as.
 * @param {string} type
 * @param {string} path
 * @param {Blob} blob
 * @returns {Promise<'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'text' | 'binary'>}
 */
async function kindOf(type, path, blob) {
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'pdf'
  if (blob.size > TEXT_LIMIT) return 'binary'
  const textual = TEXT_TYPE.test(type) || !(await blob.slice(0, 8192).text()).includes('\0')
  if (!textual) return 'binary'
  return MARKDOWN.test(path) ? 'markdown' : 'text'
}

/** @param {string} path */
const baseName = path => path.replace(/\/+$/, '').split('/').pop() || path

/**
 * @param {string} text
 * @param {number | null} line
 */
function codeHtml(text, line) {
  const lines = text.replace(/\n$/, '').split('\n')
  if (lines.length > NUMBERED_LINES) return `<pre class="viewer-code is-plain">${esc(text)}</pre>`
  const rows = lines
    .map(
      (l, i) => `<span class="viewer-line${i + 1 === line ? ' is-target' : ''}" data-n="${i + 1}">${esc(l)}\n</span>`,
    )
    .join('')
  return `<pre class="viewer-code">${rows}</pre>`
}

/**
 * The full-screen viewer, removed when closed. An object URL it `owns` is revoked then; one it borrowed (a
 * picture a reply shows) is not.
 * @param {{ name: string; path: string; url: string; kind: string; body: string; line?: number | null; owns?: boolean }} o
 */
function showViewer({ name, path, url, kind, body, line = null, owns = false }) {
  const dialog = document.createElement('dialog')
  dialog.className = `viewer is-${kind}`
  const zoom =
    kind === 'image'
      ? `<button type="button" class="icon-btn icon-btn-sm" data-viewer="zoom-out" aria-label="${esc(t('viewer.zoomOut'))}" title="${esc(t('viewer.zoomOut'))}"><span aria-hidden="true">−</span></button>
        <button type="button" class="btn btn-sm btn-ghost viewer-zoom" data-viewer="fit" title="${esc(t('viewer.fit'))}">${esc(t('viewer.fit'))}</button>
        <button type="button" class="icon-btn icon-btn-sm" data-viewer="zoom-in" aria-label="${esc(t('viewer.zoomIn'))}" title="${esc(t('viewer.zoomIn'))}"><span aria-hidden="true">+</span></button>`
      : ''
  dialog.innerHTML = `<header class="viewer-head">
      <div class="viewer-title"><b>${esc(name)}</b><span title="${esc(path)}"><bdi>${esc(path)}</bdi></span></div>
      ${zoom}
      <button type="button" class="icon-btn icon-btn-sm" data-viewer="copy-path" aria-label="${esc(t('viewer.copyPath'))}" title="${esc(t('viewer.copyPath'))}">${icon('copy')}</button>
      <a class="icon-btn icon-btn-sm" href="${esc(url)}" download="${esc(name)}" aria-label="${esc(t('viewer.download'))}" title="${esc(t('viewer.download'))}">${icon('download')}</a>
      <button type="button" class="icon-btn icon-btn-sm" data-viewer="close" autofocus aria-label="${esc(t('viewer.close'))}" title="${esc(t('viewer.close'))}">${icon('x')}</button>
    </header>
    <div class="viewer-body">${body}</div>`
  document.body.append(dialog)
  dialog.addEventListener('close', () => {
    dialog.remove()
    if (owns) URL.revokeObjectURL(url)
  })
  // A click on the backdrop (the dialog itself, outside its content) closes it.
  dialog.addEventListener('click', e => {
    if (e.target === dialog) dialog.close()
  })
  const img = /** @type {HTMLImageElement | null} */ (dialog.querySelector('.viewer-image'))
  let scale = 0
  const applyZoom = () => {
    if (!img) return
    img.classList.toggle('is-zoomed', scale > 0)
    img.style.width = scale > 0 ? `${Math.round(img.naturalWidth * scale)}px` : ''
    const label = dialog.querySelector('.viewer-zoom')
    if (label) label.textContent = scale > 0 ? `${Math.round(scale * 100)}%` : t('viewer.fit')
  }
  const fitted = () => (img ? img.getBoundingClientRect().width / (img.naturalWidth || 1) : 1)
  img?.addEventListener('click', () => {
    scale = scale > 0 ? 0 : 1
    applyZoom()
  })
  dialog.addEventListener('click', async e => {
    const action = /** @type {HTMLElement} */ (e.target)
      .closest('[data-viewer]')
      ?.getAttribute('data-viewer')
    if (action === 'close') dialog.close()
    else if (action === 'copy-path') {
      const ok = await copyText(path)
      toast(ok ? t('toast.copied') : t('toast.copyFailed'), '', ok ? '' : 'error')
    } else if (action === 'zoom-in' || action === 'zoom-out') {
      const from = scale > 0 ? scale : fitted()
      scale = Math.min(8, Math.max(0.05, action === 'zoom-in' ? from * ZOOM_STEP : from / ZOOM_STEP))
      applyZoom()
    } else if (action === 'fit') {
      scale = 0
      applyZoom()
    }
  })
  dialog.showModal()
  if (line) dialog.querySelector('.viewer-line.is-target')?.scrollIntoView({ block: 'center' })
  return dialog
}

/**
 * A picture already in the page (an attachment's thumbnail, an image in a reply), full screen.
 * @param {string} src
 * @param {string} name
 */
export function openImage(src, name) {
  showViewer({
    name,
    path: name,
    url: src,
    kind: 'image',
    body: `<img class="viewer-image" src="${esc(src)}" alt="${esc(name)}">`,
  })
}

/**
 * Open a file an agent named, resolved against the pane's folder: shown when the browser can, else offered as a
 * download.
 * @param {string} pane
 * @param {string} reference `path`, `path:line` or `path#L12`
 */
export async function openFile(pane, reference) {
  const { path: asked, line } = splitLocation(reference)
  let file
  try {
    file = await fetchFile(pane, asked)
  } catch (err) {
    toast(t('viewer.failed', { path: asked }), /** @type {Error} */ (err).message, 'error')
    return
  }
  const { blob, type, path } = file
  const name = baseName(path)
  const kind = await kindOf(type, path, blob)
  const url = URL.createObjectURL(blob)
  let body = ''
  if (kind === 'image') body = `<img class="viewer-image" src="${esc(url)}" alt="${esc(name)}">`
  else if (kind === 'video') body = `<video class="viewer-media" src="${esc(url)}" controls playsinline></video>`
  else if (kind === 'audio') body = `<audio class="viewer-media" src="${esc(url)}" controls></audio>`
  else if (kind === 'pdf') body = `<iframe class="viewer-pdf" src="${esc(url)}" title="${esc(name)}"></iframe>`
  else if (kind === 'markdown' && !line) body = `<div class="viewer-doc markdown">${markdown(await blob.text())}</div>`
  else if (kind === 'text' || kind === 'markdown') body = codeHtml(await blob.text(), line)
  else
    body = `<div class="viewer-binary">${icon('file', 'md')}<p>${esc(t('viewer.noPreview', { size: sizeLabel(blob.size) }))}</p><a class="btn btn-primary" href="${esc(url)}" download="${esc(name)}">${esc(t('viewer.download'))}</a></div>`
  const dialog = showViewer({ name, path, url, kind, body, line, owns: true })
  // Pictures and files a Markdown file names are next to it, not next to the pane.
  if (kind === 'markdown' && !line) {
    const base = dirName(path)
    for (const el of dialog.querySelectorAll('[data-open-file]')) {
      const ref = el.getAttribute('data-open-file') ?? ''
      if (!/^[/~]/.test(ref)) el.setAttribute('data-open-file', `${base}/${ref.replace(/^\.\//, '')}`)
    }
    loadReplyImages(dialog, pane, base)
  }
}

/** @param {string} path */
const dirName = path => path.replace(/\/[^/]*$/, '') || '/'

/** @param {number} bytes */
function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1 << 20) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1 << 20)).toFixed(1)} MB`
}

const IMAGE_CACHE = 200
/** @type {Map<string, Promise<string | null>>} object URLs of pictures in replies, by pane and path */
const replyImages = new Map()

/**
 * @param {string} pane
 * @param {string} path
 */
function replyImage(pane, path) {
  const key = `${pane}\n${path}`
  let url = replyImages.get(key)
  if (!url) {
    url = fetchFile(pane, path)
      .then(file => (file.type.startsWith('image/') ? URL.createObjectURL(file.blob) : null))
      .catch(() => null)
    replyImages.set(key, url)
    if (replyImages.size > IMAGE_CACHE) {
      const [oldest, gone] = replyImages.entries().next().value ?? []
      if (oldest) replyImages.delete(oldest)
      gone?.then(u => u && URL.revokeObjectURL(u))
    }
  }
  return url
}

/**
 * Show the pictures on this machine that replies under `root` name (marked by the Markdown renderer). A relative
 * path is resolved against `base` when given (the folder of a Markdown file on show), else the pane's folder.
 * @param {ParentNode} root
 * @param {string | null} pane
 * @param {string} [base]
 */
export function loadReplyImages(root, pane, base) {
  if (!pane) return
  for (const img of root.querySelectorAll('img[data-file-image]:not([src])')) {
    const named = img.getAttribute('data-file-image') ?? ''
    const path = base && !/^[/~]/.test(named) ? `${base}/${named.replace(/^\.\//, '')}` : named
    img.setAttribute('src', '')
    void replyImage(pane, path).then(url => {
      if (url) img.setAttribute('src', url)
      else img.replaceWith(Object.assign(document.createElement('code'), { textContent: path }))
    })
  }
}

/** A click (or Enter) on anything marked `data-open-file` opens it, resolved against the selected pane. */
export function initViewer() {
  /** @param {Event} e */
  const open = e => {
    const target = /** @type {HTMLElement} */ (e.target)
    if (target instanceof HTMLImageElement && target.closest('.markdown') && target.src && !target.closest('a')) {
      e.preventDefault()
      return openImage(target.src, baseName(target.getAttribute('data-file-image') || target.alt || target.src))
    }
    const el = target.closest?.('[data-open-file]')
    const ref = el?.getAttribute('data-open-file')
    if (!el || !ref || !state.selected) return
    e.preventDefault()
    if (el.querySelector('img') && !el.closest('.markdown')) {
      const img = /** @type {HTMLImageElement} */ (el.querySelector('img'))
      return openImage(img.src, baseName(ref))
    }
    void openFile(state.selected, ref)
  }
  document.addEventListener('click', open)
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && /** @type {HTMLElement} */ (e.target).matches?.('.file-ref')) open(e)
  })
}
