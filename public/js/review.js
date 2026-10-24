import { getJson } from './api.js'
import { sendCommand } from './composer.js'
import { diffRows, diffSignature, patchFor, samePath, splitDiff } from './diff.js'
import { $, esc, icon } from './dom.js'
import { t } from './i18n/index.js'
import { renderBar } from './navigation.js'
import { state } from './state.js'
import { terminal } from './terminal.js'

let diffTimer = null
// The file the diff area shows ('' for all files), so a refresh of the same view keeps its scroll position.
let shownFile = null

/** @param {boolean} [force] repaint even when the content is unchanged (the Refresh button). */
export async function loadDiff(force = false) {
  clearTimeout(diffTimer)
  const pane = state.selected
  if (!pane) return
  try {
    const diff = await getJson('/api/diff', { pane })
    if (pane !== state.selected) return
    const signature = diffSignature(diff)
    const changed = force || signature !== state.diffSignature
    state.diff = diff
    state.diffSignature = signature
    renderBar()
    if (state.reviewOpen && changed) renderReview()
  } catch {
    if (pane === state.selected) {
      state.diff = null
      state.diffSignature = ''
      renderBar()
    }
  }
  if (pane === state.selected) diffTimer = setTimeout(loadDiff, state.reviewOpen ? 5000 : 12_000)
}

export function stopDiffPolling() {
  clearTimeout(diffTimer)
  diffTimer = null
}

export function setReviewOpen(open) {
  state.reviewOpen = open
  $('#review').hidden = !open
  $('#app').classList.toggle('is-review-open', open)
  if (open) {
    renderReview()
    loadDiff()
  }
  if (state.selected) renderBar()
  setTimeout(() => terminal.refit(), 60)
}

function placeholder(text) {
  shownFile = null
  $('#review-files').innerHTML = ''
  $('#review-diff').innerHTML = `<div class="review-empty">${esc(text)}</div>`
}

function rowsHtml(lines) {
  return diffRows(lines)
    .map(row => {
      if (row.type === 'hunk') return `<div class="diff-hunk">${esc(row.text)}</div>`
      if (row.type === 'note') return `<div class="diff-note">${esc(row.text)}</div>`
      return `<div class="diff-row is-${row.type}"><span class="diff-gutter">${row.line ?? ''}</span><span class="diff-code">${esc(row.text)}</span></div>`
    })
    .join('')
}

function fileDiffHtml(path, lines, note = '') {
  const body = lines?.length ? rowsHtml(lines) : `<div class="diff-note">${esc(note)}</div>`
  return `<section class="diff-file"><h3 class="diff-file-head" data-file="${esc(path)}">${esc(path)}</h3>${body}</section>`
}

function fileCounts(f) {
  const added = `<span class="diff-add">+${f.added}</span>`
  if (f.binary)
    return `<span class="review-new">${esc(f.untracked ? t('review.newBinary') : t('review.binary'))}</span>`
  if (f.untracked) return `<span class="review-new">${esc(t('review.newFile'))}</span>${added}`
  return `${added}<span class="diff-del">−${f.removed}</span>`
}

export function renderReview() {
  const diff = state.diff
  $('#review-stat').innerHTML = diff
    ? `<span class="diff-add">+${diff.added}</span> <span class="diff-del">−${diff.removed}</span>`
    : ''
  if (!diff) return placeholder(t('review.loading'))
  if (!diff.files.length) return placeholder(t('review.clean'))
  const wanted = state.reviewFile
  const known = diff.files.find(f => f.path === wanted) ?? diff.files.find(f => samePath(f.path, wanted))
  const selected = known ? known.path : null
  const all = `<button type="button" class="review-file review-all" data-file="" aria-current="${!selected}">${icon('list')}<span class="review-file-path">${esc(t('review.allFiles', { n: diff.files.length }))}</span></button>`
  $('#review-files').innerHTML =
    all +
    diff.files
      .map(
        f =>
          `<button type="button" class="review-file" data-file="${esc(f.path)}" aria-current="${f.path === selected}">${icon('file')}<span class="review-file-path">${esc(f.path)}</span>${fileCounts(f)}</button>`,
      )
      .join('')
  const patches = splitDiff(diff.diff)
  const box = $('#review-diff')
  // Repainting the same view (a refresh) keeps the reader's place; another file starts at its top.
  const view = selected ?? ''
  const top = shownFile === view ? box.scrollTop : 0
  shownFile = view
  // A picked file shows its own patch and nothing else, so another file's lines never pass for it.
  if (selected) {
    const patch = patchFor(patches, selected)
    box.innerHTML = fileDiffHtml(selected, patch?.lines, known.binary ? t('review.binaryBody') : t('review.noPatch'))
  } else {
    const html = patches.map(p => fileDiffHtml(p.path, p.lines, t('review.noPatch'))).join('')
    box.innerHTML = html || `<div class="review-empty">${esc(t('review.untrackedOnly'))}</div>`
  }
  box.scrollTop = top
}

export function initReview() {
  $('#diff-btn').addEventListener('click', () => setReviewOpen(!state.reviewOpen))
  $('#review-close').addEventListener('click', () => setReviewOpen(false))
  $('#review-refresh').addEventListener('click', () => loadDiff(true))
  $('#review-files').addEventListener('click', e => {
    const file = e.target.closest('[data-file]')
    if (!file) return
    state.reviewFile = file.dataset.file || null
    renderReview()
  })
  $('#review-form').addEventListener('submit', async e => {
    e.preventDefault()
    const input = $('#review-text')
    const text = input.value.trim()
    if (!text) return
    const scope = state.reviewFile ? t('review.aboutFile', { file: state.reviewFile }) : t('review.aboutAll')
    if (await sendCommand(scope + text, t('toast.sent'))) input.value = ''
  })
}
