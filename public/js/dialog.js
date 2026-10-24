import { esc } from './dom.js'
import { t } from './i18n/index.js'

function openDialog(innerHtml, setup) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog')
    dialog.className = 'dialog'
    dialog.innerHTML = `<form method="dialog" class="dialog-form">${innerHtml}</form>`
    document.body.append(dialog)
    let result = null
    const finish = value => {
      result = value
      dialog.close()
    }
    dialog.addEventListener('close', () => {
      dialog.remove()
      resolve(result)
    })
    setup(dialog, finish)
    dialog.showModal()
  })
}

/**
 * @param {{ title: string; body?: string; confirmLabel?: string; danger?: boolean }} options
 * @returns {Promise<boolean>}
 */
export async function confirmDialog({ title, body = '', confirmLabel = t('dialog.ok'), danger = false }) {
  const html = `<h2 class="dialog-title">${esc(title)}</h2>${body ? `<p class="dialog-body">${esc(body)}</p>` : ''}
    <div class="dialog-actions"><button type="button" class="btn btn-ghost" data-cancel>${esc(t('dialog.cancel'))}</button>
    <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" autofocus>${esc(confirmLabel)}</button></div>`
  const ok = await openDialog(html, (dialog, finish) => {
    dialog.querySelector('[data-cancel]').onclick = () => finish(false)
    dialog.querySelector('form').addEventListener('submit', e => {
      e.preventDefault()
      finish(true)
    })
  })
  return ok === true
}

/**
 * @param {{ title: string; label: string; value?: string; hint?: string; validate?: (value: string) => string | null }} options
 *   `validate` returns an error message or null
 * @returns {Promise<string | null>} null when cancelled
 */
export function promptDialog({ title, label, value = '', hint = '', validate }) {
  const html = `<h2 class="dialog-title">${esc(title)}</h2>
    <label class="dialog-field"><span>${esc(label)}</span><input class="input" name="value" autocomplete="off" spellcheck="false" value="${esc(value)}"></label>
    <p class="dialog-hint" data-hint>${esc(hint)}</p>
    <div class="dialog-actions"><button type="button" class="btn btn-ghost" data-cancel>${esc(t('dialog.cancel'))}</button>
    <button type="submit" class="btn btn-primary">${esc(t('dialog.ok'))}</button></div>`
  return openDialog(html, (dialog, finish) => {
    const input = dialog.querySelector('input')
    const hintEl = dialog.querySelector('[data-hint]')
    dialog.querySelector('[data-cancel]').onclick = () => finish(null)
    input.addEventListener('input', () => {
      hintEl.textContent = hint
      hintEl.classList.remove('is-error')
    })
    dialog.querySelector('form').addEventListener('submit', e => {
      e.preventDefault()
      const v = input.value.trim()
      const error = validate?.(v)
      if (error) {
        hintEl.textContent = error
        hintEl.classList.add('is-error')
        input.focus()
        return
      }
      finish(v)
    })
    setTimeout(() => input.select(), 0)
  })
}

/** @param {{ title: string; html: string }} options `html` must already be escaped */
export function infoDialog({ title, html }) {
  const body = `<h2 class="dialog-title">${esc(title)}</h2><div class="dialog-body">${html}</div>
    <div class="dialog-actions"><button type="submit" class="btn btn-primary" autofocus>${esc(t('dialog.ok'))}</button></div>`
  return openDialog(body, () => {})
}

/**
 * The agent's input box in the terminal holds text nobody sent, and a reply would be typed into it.
 * @param {string} draft
 * @returns {Promise<boolean>} true to clear it and send
 */
export async function draftDialog(draft) {
  const html = `<h2 class="dialog-title">${esc(t('draft.title'))}</h2><p class="dialog-body">${esc(t('draft.body'))}</p>
    <pre class="dialog-draft">${esc(draft)}</pre>
    <div class="dialog-actions"><button type="button" class="btn btn-ghost" data-cancel>${esc(t('dialog.cancel'))}</button>
    <button type="submit" class="btn btn-danger">${esc(t('draft.replace'))}</button></div>`
  const replace = await openDialog(html, (dialog, finish) => {
    dialog.querySelector('[data-cancel]').onclick = () => finish(false)
    dialog.querySelector('form').addEventListener('submit', e => {
      e.preventDefault()
      finish(true)
    })
  })
  return replace === true
}
