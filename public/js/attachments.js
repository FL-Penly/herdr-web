import { isUnauthorized, uploadFile, uploadWithProgress } from './api.js'
import { $, esc, icon, isTouch } from './dom.js'
import { ATTACHMENT_TOKEN_RE, sentMessageKey, uploadDisplayName, uploadName } from './format.js'
import { t } from './i18n/index.js'
import { openMenu } from './menus.js'
import { toast } from './notify.js'
import { state } from './state.js'
import { openFile, openImage } from './viewer.js'

const listeners = new Set()
const IMAGE_TYPE_RE = /^image\//

/**
 * Uploads still running, per composer: a message may not go out without them (it would reach the agent
 * without the file).
 * @type {{ reply: { id: number; name: string; progress: number; thumb: string; abort: () => void }[]; home: { id: number; name: string; progress: number; thumb: string; abort: () => void }[] }}
 */
const uploads = { reply: [], home: [] }
// Each attachment's token in the message (`[图片1]`), by server path once uploaded.
const tokens = new Map()
const IMAGE_WORDS = ['图片', 'Image ']
const TOKEN_AT_END_RE = new RegExp(`(?:${ATTACHMENT_TOKEN_RE.source})$`)
let nextId = 0
// Previews of images uploaded from this tab, by server path: composer tiles and the sent message show them.
const thumbs = new Map()

// Images this tab sent, by message: Claude Code's transcript keeps only `[Image #n]` for them, not the path.
const sentImages = new Map()
const SENT_IMAGES_LIMIT = 50

/** @param {string} typed @param {string[]} paths */
export function rememberSentImages(typed, paths) {
  const images = paths.filter(p => thumbs.has(p))
  if (!images.length) return
  if (sentImages.size >= SENT_IMAGES_LIMIT) sentImages.delete(sentImages.keys().next().value)
  sentImages.set(sentMessageKey(typed), images)
}

/** The images this tab sent with the message `text` (as the transcript has it), if it sent it. */
export const sentImagesFor = text => sentImages.get(sentMessageKey(text)) ?? []

export function onAttachmentsChange(listener) {
  listeners.add(listener)
}

const changed = which => {
  renderAttachments(which)
  for (const listener of listeners) listener(which)
}

/** @param {'reply' | 'home'} which */
export const uploadingCount = which => uploads[which].length

/** @param {string} path */
export const attachmentThumb = path => thumbs.get(path) ?? ''

export async function uploadFiles(files) {
  const paths = []
  for (const file of files) {
    try {
      paths.push(await uploadFile(file, uploadName(file)))
    } catch (err) {
      if (isUnauthorized(err)) break
      toast(t('toast.uploadFailed'), err.message, 'error')
    }
  }
  return paths
}

export const filesFromTransfer = transfer =>
  [...(transfer?.items ?? [])]
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter(Boolean)

/** @param {string} token */
const tokenBadge = token => (token ? `<span class="attachment-token">${esc(token.slice(1, -1))}</span>` : '')

function doneTile(which, path, i) {
  const thumb = thumbs.get(path)
  const glyph = thumb ? `<img class="attachment-thumb" src="${esc(thumb)}" alt="">` : icon('file')
  return `<span class="attachment" title="${esc(path)}">${glyph}${tokenBadge(tokens.get(path) ?? '')}<span class="attachment-name">${esc(uploadDisplayName(path))}</span><button type="button" class="attachment-remove" data-remove="${which}:${i}" aria-label="${esc(t('composer.removeAttachment'))}">×</button></span>`
}

function uploadingTile(which, upload) {
  const glyph = upload.thumb
    ? `<img class="attachment-thumb" src="${esc(upload.thumb)}" alt="">`
    : '<span class="dot dot-running" aria-hidden="true"></span>'
  const percent = `${Math.round(upload.progress * 100)}%`
  return `<span class="attachment is-uploading" style="--progress: ${percent}">${glyph}${tokenBadge(upload.token)}<span class="attachment-name">${esc(upload.name)}</span><span class="attachment-progress">${esc(t('composer.uploading', { percent }))}</span><button type="button" class="attachment-remove" data-cancel-upload="${which}:${upload.id}" aria-label="${esc(t('composer.cancelUpload'))}">×</button></span>`
}

export function renderAttachments(which) {
  const running = uploads[which]
  const hint = running.length
    ? `<span class="attachments-hint" role="status">${esc(t('composer.waitingForUpload', { n: running.length }))}</span>`
    : ''
  // An attachment whose token is in the text shows there, as a capsule; a tile is left for one that lost it.
  const text = field(which).value
  $(`#${which}-attachments`).innerHTML =
    state.attachments[which]
      .map((path, i) => (text.includes(tokens.get(path) || '\0') ? '' : doneTile(which, path, i)))
      .join('') +
    running.map(upload => uploadingTile(which, upload)).join('') +
    hint
}

/** Stops the uploads of a composer that is being cleared (another pane was opened). */
export function cancelUploads(which) {
  for (const upload of uploads[which].splice(0)) {
    upload.abort()
    if (upload.thumb) URL.revokeObjectURL(upload.thumb)
  }
  renderAttachments(which)
}

/** The composer's textarea. @param {'reply' | 'home'} which */
const field = which => /** @type {HTMLTextAreaElement} */ ($(`#${which}-text`))

/**
 * The next free token of its kind in a composer: one past the highest in its text or on its attachments.
 * @param {'reply' | 'home'} which
 * @param {boolean} image
 */
function nextToken(which, image) {
  const words = image ? IMAGE_WORDS : ['附件', 'File ']
  const taken = [
    ...(field(which).value.match(ATTACHMENT_TOKEN_RE) ?? []),
    ...state.attachments[which].map(path => tokens.get(path) ?? ''),
    ...uploads[which].map(u => u.token),
  ]
  let n = 0
  for (const token of taken) {
    const m = /^\[(\D+)(\d+)\]$/.exec(token)
    if (m && words.includes(m[1])) n = Math.max(n, Number(m[2]))
  }
  return `[${t(image ? 'attach.tokenImage' : 'attach.tokenFile', { n: n + 1 })}]`
}

/** Put `token` into the message at the caret, as the place the file belongs. */
function insertToken(which, token) {
  const el = field(which)
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  el.value = el.value.slice(0, start) + token + el.value.slice(end)
  el.setSelectionRange(start + token.length, start + token.length)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function removeToken(which, token) {
  const el = field(which)
  if (!token || !el.value.includes(token)) return
  el.value = el.value.replace(token, '')
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * A composer's attachments with their tokens, in the order they were added.
 * @param {'reply' | 'home'} which
 */
export const attachmentItems = which => state.attachments[which].map(path => ({ token: tokens.get(path) ?? '', path }))

function uploadOne(which, file, pane) {
  const image = IMAGE_TYPE_RE.test(file.type)
  const upload = {
    id: ++nextId,
    name: uploadName(file),
    progress: 0,
    thumb: image ? URL.createObjectURL(file) : '',
    token: nextToken(which, image),
    abort: () => {},
  }
  insertToken(which, upload.token)
  let drawn = 0
  const request = uploadWithProgress(file, upload.name, fraction => {
    upload.progress = fraction
    // Progress events come fast; redraw in steps the eye can see.
    if (fraction - drawn >= 0.05) {
      drawn = fraction
      renderAttachments(which)
    }
  })
  upload.abort = request.abort
  uploads[which].push(upload)
  changed(which)
  return request.done.then(
    path => {
      const index = uploads[which].indexOf(upload)
      if (index < 0) return
      uploads[which].splice(index, 1)
      if (which === 'reply' && state.selected !== pane) return
      if (upload.thumb) thumbs.set(path, upload.thumb)
      tokens.set(path, upload.token)
      state.attachments[which].push(path)
      changed(which)
    },
    err => {
      const index = uploads[which].indexOf(upload)
      if (index >= 0) uploads[which].splice(index, 1)
      if (upload.thumb) URL.revokeObjectURL(upload.thumb)
      if (which !== 'reply' || state.selected === pane) removeToken(which, upload.token)
      if (err.code !== 'aborted' && !isUnauthorized(err)) toast(t('toast.uploadFailed'), err.message, 'error')
      changed(which)
    },
  )
}

function addFiles(which, files) {
  const pane = state.selected
  return Promise.all(files.map(file => uploadOne(which, file, pane)))
}

function cancelUpload(which, id) {
  const list = Object.hasOwn(uploads, which) ? uploads[which] : null
  if (!list) return
  const index = list.findIndex(u => u.id === id)
  if (index < 0) return
  const [upload] = list.splice(index, 1)
  upload.abort()
  removeToken(which, upload.token)
  changed(which)
}

// Backspace right after a token takes it out whole, and its attachment with it: it is one thing, like a chip.
function backspaceToken(which, e) {
  const el = field(which)
  if (e.key !== 'Backspace' || el.selectionStart !== el.selectionEnd || e.isComposing) return
  const caret = el.selectionStart ?? 0
  const token = TOKEN_AT_END_RE.exec(el.value.slice(0, caret))?.[0]
  if (!token) return
  e.preventDefault()
  el.value = el.value.slice(0, caret - token.length) + el.value.slice(caret)
  el.setSelectionRange(caret - token.length, caret - token.length)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  const index = state.attachments[which].findIndex(path => tokens.get(path) === token)
  if (index >= 0) {
    state.attachments[which].splice(index, 1)
    return changed(which)
  }
  const upload = uploads[which].find(u => u.token === token)
  if (upload) cancelUpload(which, upload.id)
}

// The text drawn under the textarea, whose own text is transparent (its caret and selection stay): a token shows
// as a capsule, its brackets hidden.
function paintTokens(el, mirror) {
  mirror.innerHTML = `${esc(el.value).replace(ATTACHMENT_TOKEN_RE, token => `<mark><i>[</i>${token.slice(1, -1)}<i>]</i></mark>`)}\n`
  mirror.scrollTop = el.scrollTop
}

/**
 * The token under the pointer, from the capsules drawn under the textarea.
 * @param {HTMLElement} mirror
 * @param {MouseEvent} e
 */
function tokenAt(mirror, e) {
  for (const mark of mirror.querySelectorAll('mark')) {
    for (const r of mark.getClientRects()) {
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
        return `[${mark.textContent?.slice(1, -1)}]`
    }
  }
  return null
}

// A click on a capsule shows its file: a picture full screen from this tab's copy, anything else in the viewer.
function previewToken(which, token) {
  const path = state.attachments[which].find(p => tokens.get(p) === token)
  if (!path) return false
  const thumb = thumbs.get(path)
  const pane = state.selected ?? state.agents[0]?.pane
  if (thumb) openImage(thumb, uploadDisplayName(path))
  else if (pane) void openFile(pane, path)
  else return false
  return true
}

export function initAttachments() {
  const input = $('#file-input')
  let target = 'reply'
  document.addEventListener('click', e => {
    const remove = e.target.closest('[data-remove]')
    if (remove) {
      const [which, index] = remove.dataset.remove.split(':')
      const [path] = state.attachments[which].splice(Number(index), 1)
      removeToken(which, tokens.get(path) ?? '')
      return changed(which)
    }
    // Namespaced: dialogs use a bare `data-cancel` for their own Cancel buttons.
    const cancel = e.target.closest('[data-cancel-upload]')
    if (cancel) {
      const [which, id] = cancel.dataset.cancelUpload.split(':')
      return cancelUpload(which, Number(id))
    }
    const attach = e.target.closest('[data-attach]')
    if (!attach) return
    target = attach.dataset.attach
    if (!isTouch()) return pick({})
    openMenu(attach, [
      { label: t('attach.camera'), icon: 'camera', run: () => pick({ accept: 'image/*', capture: 'environment' }) },
      { label: t('attach.photos'), icon: 'image', run: () => pick({ accept: 'image/*' }) },
      { label: t('attach.files'), icon: 'file', run: () => pick({}) },
    ])
  })
  const pick = ({ accept = '', capture = '' }) => {
    input.accept = accept
    input.multiple = !capture
    if (capture) input.setAttribute('capture', capture)
    else input.removeAttribute('capture')
    input.click()
  }
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])]
    input.value = ''
    addFiles(target, files)
  })
  for (const which of /** @type {const} */ (['reply', 'home'])) {
    const textarea = field(which)
    const wrap = document.createElement('div')
    wrap.className = 'composer-field'
    const mirror = document.createElement('div')
    mirror.className = 'composer-mirror'
    mirror.setAttribute('aria-hidden', 'true')
    textarea.replaceWith(wrap)
    wrap.append(mirror, textarea)
    const paint = () => paintTokens(textarea, mirror)
    for (const type of ['input', 'autosize', 'scroll']) textarea.addEventListener(type, paint)
    // An input method's text being composed (pinyin before it becomes 队列) may reach the mirror late or not at
    // all, while the caret already stands after it: the textarea shows its own text until the composition ends.
    textarea.addEventListener('compositionstart', () => wrap.classList.add('is-composing'))
    textarea.addEventListener('compositionend', () => {
      wrap.classList.remove('is-composing')
      paint()
    })
    textarea.addEventListener('input', () => renderAttachments(which))
    // Text set from code (a draft loaded, a sent message cleared) is drawn too.
    const value = /** @type {PropertyDescriptor} */ (
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    )
    Object.defineProperty(textarea, 'value', {
      configurable: true,
      get() {
        return value.get?.call(this)
      },
      set(v) {
        value.set?.call(this, v)
        paint()
      },
    })
    textarea.addEventListener('click', e => {
      const token = tokenAt(mirror, e)
      if (token && textarea.selectionStart === textarea.selectionEnd && previewToken(which, token)) e.preventDefault()
    })
    textarea.addEventListener('mousemove', e => {
      textarea.style.cursor = tokenAt(mirror, e) ? 'pointer' : ''
    })
    textarea.addEventListener('keydown', e => backspaceToken(which, e))
    textarea.addEventListener('paste', e => {
      const files = filesFromTransfer(e.clipboardData)
      if (!files.length) return
      e.preventDefault()
      addFiles(which, files)
    })
    const box = textarea.closest('.composer-box')
    box.addEventListener('dragover', e => {
      e.preventDefault()
      box.classList.add('is-dragging')
    })
    box.addEventListener('dragleave', () => box.classList.remove('is-dragging'))
    box.addEventListener('drop', e => {
      e.preventDefault()
      box.classList.remove('is-dragging')
      if (textarea.disabled) return
      addFiles(which, [...(e.dataTransfer?.files ?? [])])
    })
  }
}
