import { commandCatalog } from './catalogs.js'
import { homeDir } from './dirs.js'
import { $, esc, isTouch } from './dom.js'
import { t } from './i18n/index.js'
import { commandDescription, commandSourceLabel } from './labels.js'
import { isAgentKind } from './model.js'
import { placePopup } from './placement.js'
import { commandPool, rankCommands, slashQuery } from './slash-rank.js'
import { selectedAgent, state } from './state.js'

const picker = {
  textarea: null,
  kind: '',
  items: [],
  index: 0,
  from: 0,
  trigger: '/',
  query: null,
}

const listEl = () => $('#slash')
const isSlashOpen = () => !listEl().hidden

function contextFor(textarea) {
  if (textarea.id === 'reply-text') {
    const agent = selectedAgent()
    return agent && isAgentKind(agent.kind) ? { kind: agent.kind, cwd: agent.cwd } : null
  }
  if (state.homeAgent === 'shell') return null
  return { kind: state.homeAgent, cwd: homeDir() }
}

export function closeSlash() {
  const el = listEl()
  if (el.hidden) return false
  el.hidden = true
  picker.textarea?.removeAttribute('aria-activedescendant')
  picker.textarea?.setAttribute('aria-expanded', 'false')
  picker.textarea = null
  picker.query = null
  return true
}

async function update(textarea) {
  const context = contextFor(textarea)
  const before = textarea.value.slice(0, textarea.selectionStart)
  const match = context && slashQuery(before, context.kind)
  if (!match) return closeSlash()
  const catalog = await commandCatalog(context.kind, context.cwd)
  if (textarea.value.slice(0, textarea.selectionStart) !== before) return
  const items = rankCommands(commandPool(match.trigger, context.kind, catalog), match.query)
  if (!items.length) return closeSlash()
  const changed = picker.textarea !== textarea || picker.query !== match.query
  Object.assign(picker, {
    textarea,
    kind: context.kind,
    items,
    trigger: match.trigger,
    query: match.query,
    from: match.from,
    index: changed ? 0 : Math.min(picker.index, items.length - 1),
  })
  render()
}

/** The band of the window that is visible; on phones the on-screen keyboard covers the rest. */
function visibleBand() {
  const vv = window.visualViewport
  return vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height } : { top: 0, bottom: window.innerHeight }
}

function position(el) {
  if (!picker.textarea) return
  const box = picker.textarea.closest('.composer-box').getBoundingClientRect()
  el.style.left = `${box.left}px`
  el.style.width = `${box.width}px`
  el.style.bottom = ''
  el.style.maxHeight = ''
  const natural = Math.min(el.scrollHeight, el.getBoundingClientRect().height || el.scrollHeight)
  const place = placePopup(box, visibleBand(), natural)
  el.style.maxHeight = `${place.maxHeight}px`
  el.style.top = `${place.top}px`
}

function render() {
  const el = listEl()
  const run = picker.trigger === '/' ? t('slash.run') : t('slash.insert')
  const heading = picker.trigger === '/' ? t('slash.commands') : t('slash.skills')
  el.innerHTML =
    `<div class="menu-header" role="presentation">${esc(heading)}${isTouch() ? '' : ` · ${esc(t('slash.keys', { action: run }))}`}</div>` +
    picker.items
      .map(
        (c, i) =>
          `<div class="slash-item" role="option" id="slash-${i}" data-index="${i}" aria-selected="${i === picker.index}"><b>${esc((c.mark || picker.trigger) + c.name)}</b><span class="slash-desc">${esc(commandDescription(c, picker.kind))}</span><span class="slash-source">${esc(commandSourceLabel(c))}</span></div>`,
      )
      .join('')
  el.hidden = false
  position(el)
  picker.textarea.setAttribute('aria-expanded', 'true')
  picker.textarea.setAttribute('aria-activedescendant', `slash-${picker.index}`)
  el.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
}

function pick(submit) {
  const command = picker.items[picker.index]
  const textarea = picker.textarea
  if (!command || !textarea) return
  const end = textarea.selectionStart
  const insert = `${command.mark || picker.trigger}${command.name} `
  textarea.value = textarea.value.slice(0, picker.from) + insert + textarea.value.slice(end)
  textarea.selectionStart = textarea.selectionEnd = picker.from + insert.length
  closeSlash()
  textarea.dispatchEvent(new Event('input'))
  if (submit && !command.mark) textarea.closest('form').requestSubmit()
}

export function initSlash() {
  for (const textarea of [$('#reply-text'), $('#home-text')]) {
    textarea.setAttribute('aria-controls', 'slash')
    textarea.setAttribute('aria-autocomplete', 'list')
    textarea.addEventListener('input', () => update(textarea))
    textarea.addEventListener('click', () => update(textarea))
    textarea.addEventListener('blur', () =>
      setTimeout(() => {
        if (picker.textarea === textarea && document.activeElement !== textarea) closeSlash()
      }, 120),
    )
    textarea.addEventListener(
      'keydown',
      e => {
        if (!isSlashOpen() || picker.textarea !== textarea || e.isComposing) return
        const count = picker.items.length
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          picker.index = (picker.index + (e.key === 'ArrowDown' ? 1 : -1) + count) % count
          render()
        } else if (e.key === 'Tab') pick(false)
        else if (e.key === 'Enter' && !e.shiftKey) pick(picker.trigger === '/' && textarea.id === 'reply-text')
        else if (e.key === 'Escape') closeSlash()
        else return
        e.preventDefault()
        e.stopImmediatePropagation()
      },
      true,
    )
  }
  const reposition = () => isSlashOpen() && position(listEl())
  window.addEventListener('resize', reposition)
  window.visualViewport?.addEventListener('resize', reposition)
  window.visualViewport?.addEventListener('scroll', reposition)
  listEl().addEventListener('mousedown', e => {
    e.preventDefault()
    const item = e.target.closest('[data-index]')
    if (!item) return
    picker.index = Number(item.dataset.index)
    pick(false)
  })
}
