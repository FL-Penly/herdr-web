import { getJson, openSocket, socketRefused } from './api.js'
import { filesFromTransfer, uploadFiles } from './attachments.js'
import { $, copyText, isNarrow, narrowQuery } from './dom.js'
import { MAX_MATCHES, findMatches, quoteText } from './find.js'
import { t } from './i18n/index.js'
import { toast } from './notify.js'
import { PATH_IN_TEXT, looksLikePath } from './paths.js'
import { isMac } from './platform.js'
import { isChatPane, state } from './state.js'
import { load, save } from './storage.js'
import { onThemeChange, terminalTheme } from './theme.js'
import { clampTerminalFont, scrollLines, stepTerminalFont, withModifiers } from './touch.js'
import { openFile } from './viewer.js'
import { isKeyboardUp } from './viewport.js'

const PADDING_X = 26
const PADDING_Y = 14
const WHEEL_PX_PER_LINE = 40
// A press that moves less than this is a click, passed on to the program; more is a selection, kept here.
const CLICK_SLOP_PX = 4
const MOBILE_KEYS = {
  esc: '\x1b',
  tab: '\t',
  'ctrl-c': '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
}

const defaultFontSize = () => (isNarrow() ? 11 : 13)
const fontKey = () => (isNarrow() ? 'termFont:narrow' : 'termFont')
const baseFontSize = () => clampTerminalFont(load(fontKey(), defaultFontSize()))
// While watching, the pane keeps its own size: `fit` shrinks the text until all of it fits, `readable` keeps
// the chosen size and pans. A phone defaults to readable: a 120-column pane fitted to it is about 7px.
const viewKey = () => (isNarrow() ? 'termView:narrow' : 'termView')
const watchView = () => load(viewKey(), isNarrow() ? 'readable' : 'fit')
// Agents paint their own backgrounds (Codex's plan, diff rows) with colors chosen for a dark terminal; xterm
// lifts text that would not stand out from what is under it.
const MIN_CONTRAST = 4.5
const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
const cellCache = new Map()

// Measured the way xterm measures its cell, so the rows asked for are the rows it draws.
function cellSize(fontSize) {
  const dpr = window.devicePixelRatio || 1
  const key = `${fontSize}@${dpr}`
  let cell = cellCache.get(key)
  if (!cell) {
    const ctx = document.createElement('canvas').getContext('2d')
    ctx.font = `${fontSize}px ${monoFont()}`
    const m = ctx.measureText('W')
    const box = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent
    cell = { width: m.width, height: box > 0 ? Math.ceil(box * dpr) / dpr : Math.ceil(fontSize * 1.2) }
    cellCache.set(key, cell)
  }
  return cell
}

const host = () => $('#term')

// Protocol of /ws/term: JSON control messages both ways, binary frames are raw terminal output.
// The pane opens in `control`, resized to the browser's terminal; herdr gives it its own size back when we let go.
// When something else controls it, the pane is watched (`observe`) at its own size instead, scaled to fit.
export const terminal = {
  pane: null,
  xterm: null,
  socket: null,
  mode: null,
  queue: [],
  cols: 0,
  rows: 0,
  startedAt: 0,
  // The control asked for on opening: refused, it falls back to watching instead of reporting a lost race.
  opening: false,
  wheelAccumulator: 0,
  // The key bar's modifiers: 1 for the next key, 2 held until tapped again.
  mods: { ctrl: 0, alt: 0, shift: 0 },

  fit() {
    const el = host()
    const { width, height } = this.cell()
    return {
      cols: Math.max(20, Math.floor((el.clientWidth - PADDING_X) / width)),
      rows: Math.max(5, Math.floor((el.clientHeight - PADDING_Y) / height)),
    }
  },

  // The cell as drawn once xterm shows the font we fit for (fallback fonts can make it taller than measured).
  cell() {
    const xterm = this.xterm
    const screen = xterm?.element?.querySelector('.xterm-screen')
    if (screen && xterm.options.fontSize === baseFontSize() && xterm.cols && xterm.rows) {
      const { width, height } = screen.getBoundingClientRect()
      if (width && height) return { width: width / xterm.cols, height: height / xterm.rows }
    }
    return cellSize(baseFontSize())
  },

  attach(pane) {
    this.detach()
    if (!pane) return
    this.pane = pane
    const xterm = new window.Terminal({
      fontFamily: monoFont(),
      fontSize: baseFontSize(),
      lineHeight: 1,
      theme: terminalTheme(),
      scrollback: 0,
      allowProposedApi: true,
      cursorBlink: true,
      macOptionIsMeta: true,
      minimumContrastRatio: MIN_CONTRAST,
    })
    xterm.loadAddon(new window.Unicode11Addon.Unicode11Addon())
    xterm.unicode.activeVersion = '11'
    xterm.loadAddon(
      new window.WebLinksAddon.WebLinksAddon((_, uri) => window.open(uri, '_blank', 'noopener,noreferrer')),
    )
    xterm.open(host())
    this.xterm = xterm
    xterm.onData(data => this.input(data))
    xterm.attachCustomKeyEventHandler(e => this.onKey(e))
    xterm.attachCustomWheelEventHandler(e => {
      this.scrollBy(e.deltaY, WHEEL_PX_PER_LINE)
      return false
    })
    xterm.registerLinkProvider({ provideLinks: (y, done) => done(fileLinks(xterm, y, () => this.pane)) })
    xterm.textarea.addEventListener('paste', e => this.onPaste(e), true)
    xterm.onSelectionChange(() => {
      if (!xterm.hasSelection()) hideSelectionChip()
    })
    this.opening = true
    this.connect(this.fit())
    this.renderStatus()
  },

  // Returning false keeps a key away from the pane so the app's own shortcuts still work.
  // On Linux/Windows Ctrl+K/J/B belong to the shell (readline, tmux); press Ctrl+] to leave the terminal first.
  onKey(e) {
    if (e.type !== 'keydown') return true
    const key = e.key.toLowerCase()
    if (e.ctrlKey && e.key === ']') {
      this.xterm.blur()
      return false
    }
    if (isMac && e.metaKey && ['k', 'j', 'b'].includes(key)) return false
    if (e.altKey && (e.code === 'KeyN' || e.code === 'KeyF')) return false
    if (isMac ? e.metaKey && key === 'f' : e.ctrlKey && e.shiftKey && key === 'f') {
      e.preventDefault()
      openTextView(true)
      return false
    }
    const copy = isMac ? e.metaKey && key === 'c' : e.ctrlKey && e.shiftKey && key === 'c'
    if (copy && this.xterm.hasSelection()) {
      copyText(this.xterm.getSelection())
      return false
    }
    const paste = isMac ? e.metaKey && key === 'v' : e.ctrlKey && e.shiftKey && key === 'v'
    return !paste
  },

  connect(size) {
    const socket = openSocket('/ws/term', { pane: this.pane, cols: size.cols, rows: size.rows, mode: 'control' })
    if (!socket) return
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    let opened = false
    socket.onopen = () => {
      opened = true
    }
    socket.onmessage = e => {
      if (socket !== this.socket) return
      if (typeof e.data !== 'string') return this.xterm?.write(new Uint8Array(e.data))
      let message
      try {
        message = JSON.parse(e.data)
      } catch {
        return
      }
      if (message.type === 'mode') {
        this.mode = message.mode
        this.startedAt = Date.now()
        if (message.mode === 'control') this.flush()
        // Keys typed while the socket was being reopened are still waiting for control.
        else if (this.queue.length) this.ensureControl()
        this.renderStatus()
      } else if (message.type === 'size') this.applySize(message.cols, message.rows)
      else if (message.type === 'closed' || message.type === 'ended') this.onEnded(message)
      else if (message.type === 'stderr') toast(t('term.title'), message.text, 'error')
    }
    socket.onclose = () => {
      if (socket !== this.socket) return
      this.mode = 'closed'
      this.clearMods()
      this.renderStatus()
      if (!opened) socketRefused()
    }
  },

  // Observing shows the pane at herdr's size, so shrink the font until it fits; in control we resize the pane instead.
  applySize(cols, rows) {
    const xterm = this.xterm
    if (!xterm) return
    this.cols = cols
    this.rows = rows
    const base = baseFontSize()
    let font = base
    const fitting = this.mode !== 'control' && watchView() === 'fit'
    host().classList.toggle('is-readable', this.mode !== 'control' && !fitting)
    if (fitting) {
      const el = host()
      const { width, height } = cellSize(base)
      const scale = Math.min(
        1,
        (el.clientWidth - PADDING_X) / (cols * width),
        (el.clientHeight - PADDING_Y) / (rows * height),
      )
      font = Math.max(7, Math.floor(base * scale * 10) / 10)
    }
    if (xterm.options.fontSize !== font) xterm.options.fontSize = font
    if (xterm.cols !== cols || xterm.rows !== rows) xterm.resize(cols, rows)
    this.renderStatus()
    // Now that xterm draws the cell, make sure the rows asked for fit under it.
    if (this.mode === 'control') requestAnimationFrame(() => this.refit())
  },

  // Scrolling the pane's history needs control: herdr scrolls the pane itself, there is no local scrollback.
  scrollBy(delta, pxPerLine) {
    const { lines, carry } = scrollLines(this.wheelAccumulator, delta, pxPerLine)
    this.wheelAccumulator = carry
    if (!lines) return
    this.ensureControl()
    this.send({ type: 'scroll', direction: lines < 0 ? 'up' : 'down', lines: Math.abs(lines) })
  },

  /**
   * @param {'ctrl' | 'alt' | 'shift'} name
   * @param {number} value 0 off, 1 for the next key, 2 held
   */
  setMod(name, value) {
    this.mods[name] = value
    const button = $(`#mobile-keys [data-mod="${name}"]`)
    button.setAttribute('aria-pressed', String(value > 0))
    button.classList.toggle('is-locked', value === 2)
  },

  clearMods(all = true) {
    for (const name of /** @type {const} */ (['ctrl', 'alt', 'shift'])) {
      if (all || this.mods[name] === 1) this.setMod(name, 0)
    }
  },

  // A+/A− step from the size on screen, so they always show: past what fits, watching switches to readable.
  stepFont(direction) {
    const shown = this.xterm?.options.fontSize ?? baseFontSize()
    let next = stepTerminalFont(shown, direction)
    if (this.mode !== 'control' && watchView() === 'fit' && direction > 0 && this.cols) {
      const { width } = cellSize(next)
      // Bigger than fits: switch to readable, at the readable size chosen before if that is larger still.
      if (this.cols * width > host().clientWidth - PADDING_X) {
        save(viewKey(), 'readable')
        next = Math.max(next, baseFontSize())
      }
    }
    this.setFontSize(next)
  },

  setWatchView(view) {
    save(viewKey(), view)
    if (this.cols && this.mode !== 'control') this.applySize(this.cols, this.rows)
    this.renderStatus()
  },

  setFontSize(size) {
    save(fontKey(), clampTerminalFont(size))
    if (!this.xterm) return
    if (this.mode === 'control') {
      this.xterm.options.fontSize = baseFontSize()
      this.refit()
    } else if (this.cols) this.applySize(this.cols, this.rows)
  },

  screenText() {
    const buffer = this.xterm?.buffer.active
    if (!buffer) return ''
    const lines = []
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n').replace(/\s+$/, '')
  },

  flush() {
    if (this.queue.length) this.send({ type: 'input', data: this.queue.join('') })
    this.queue = []
  },

  onEnded(message) {
    const lostRace = this.mode === 'control' && Date.now() - this.startedAt < 2000 && message.reason !== 'detached'
    const opening = this.opening
    this.opening = false
    if (lostRace && opening && !this.queue.length) {
      $('#term-takeover').hidden = false
      // herdr's `closed` and the session's end both land here; the watcher's `mode` comes after them.
      this.mode = 'watching'
      this.send({ type: 'observe' })
      return
    }
    if (this.mode === 'watching') return
    if (lostRace) {
      $('#term-takeover').hidden = false
      toast(t('term.controlledElsewhere'), t('term.takeoverHint'), 'error')
    }
    this.mode = 'closed'
    this.renderStatus()
  },

  renderStatus() {
    const el = $('#term-mode')
    const labels = {
      control: t('term.control'),
      observe: t('term.observe'),
      closed: t('term.closed'),
      pending: t('term.pending'),
    }
    el.textContent = labels[this.mode] ?? t('term.connecting')
    el.className = `term-mode${this.mode ? ` is-${this.mode}` : ''}`
    $('#term-size').textContent = this.cols ? `${this.cols}×${this.rows}` : ''
    if (this.mode === 'control') $('#term-takeover').hidden = true
    const fit = $('#term-tools [data-term="fit"]')
    const fitting = watchView() === 'fit'
    fit.hidden = this.mode === 'control'
    fit.setAttribute('aria-pressed', String(fitting))
    fit.querySelector('.term-fit-label').textContent = t('term.fitWidth')
    fit.title = fitting ? t('term.fitOnHint') : t('term.fitOffHint')
  },

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  },

  ensureControl(takeover = false) {
    if (this.mode === 'closed') {
      const queued = this.queue
      this.attach(this.pane)
      this.queue = queued
      return
    }
    if ((this.mode === 'control' || this.mode === 'pending') && !takeover) return
    const { cols, rows } = this.fit()
    this.mode = 'pending'
    this.renderStatus()
    this.send({ type: 'control', cols, rows, takeover })
  },

  input(typed) {
    // Detached (signed out, or no pane): nothing may wait to be sent once a socket opens again.
    if (!this.pane) return
    const { ctrl, alt, shift } = this.mods
    const data = withModifiers(typed, { ctrl: ctrl > 0, alt: alt > 0, shift: shift > 0 })
    this.clearMods(false)
    if (this.mode === 'control') return this.send({ type: 'input', data })
    this.queue.push(data)
    this.ensureControl()
  },

  // A click the program may answer (Claude Code's and Codex's buttons): herdr passes it on, encoded the way the
  // program asked, only to a program that asked for the mouse.
  click(x, y) {
    const xterm = this.xterm
    const screen = xterm?.element?.querySelector('.xterm-screen')
    if (this.mode !== 'control' || !screen) return
    const r = screen.getBoundingClientRect()
    const column = Math.floor(((x - r.left) / r.width) * xterm.cols)
    const row = Math.floor(((y - r.top) / r.height) * xterm.rows)
    if (column < 0 || row < 0 || column >= xterm.cols || row >= xterm.rows) return
    for (const action of ['down', 'up']) this.send({ type: 'mouse', action, button: 'left', column, row })
  },

  paste(text) {
    this.input(/\n/.test(text) ? `\x1b[200~${text}\x1b[201~` : text)
  },

  async onPaste(e) {
    e.preventDefault()
    e.stopImmediatePropagation()
    const files = filesFromTransfer(e.clipboardData)
    if (files.length) {
      const paths = await uploadFiles(files)
      if (paths.length) this.paste(`${paths.join(' ')} `)
      return
    }
    const text = e.clipboardData.getData('text/plain')
    if (text) this.paste(text.replace(/\r\n/g, '\n'))
  },

  refit() {
    if (!this.xterm) return
    if (this.mode === 'control') {
      const { cols, rows } = this.fit()
      if (cols !== this.cols || rows !== this.rows) this.send({ type: 'resize', cols, rows })
    } else if (this.cols) this.applySize(this.cols, this.rows)
  },

  focus() {
    this.xterm?.focus()
  },

  detach() {
    if (this.socket) {
      const socket = this.socket
      this.socket = null
      socket.close()
    }
    if (this.xterm) {
      this.xterm.dispose()
      this.xterm = null
    }
    this.pane = null
    this.mode = null
    this.queue = []
    this.clearMods()
    clearTimeout(lineEnter)
    closeTextView()
    hideSelectionChip()
    this.cols = 0
    host().replaceChildren()
  },
}

/**
 * Row `y`'s text, with the column each character starts at: a wide (CJK) character takes two columns.
 * @param {any} line an xterm IBufferLine
 * @param {number} cols
 */
function rowText(line, cols) {
  let text = ''
  const at = []
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) at.push(x)
    text += chars
  }
  return { text, at }
}

/**
 * Paths on terminal row `y` (1-based), as xterm links that open in the viewer.
 * @param {any} xterm
 * @param {number} y
 * @param {() => string | null} pane
 */
function fileLinks(xterm, y, pane) {
  const line = xterm.buffer.active.getLine(y - 1)
  if (!line) return undefined
  const { text, at } = rowText(line, xterm.cols)
  const links = []
  for (const m of text.matchAll(PATH_IN_TEXT)) {
    const ref = m[0].replace(/[.,;:]+$/, '')
    if (!looksLikePath(ref) || m.index === undefined) continue
    const start = at[m.index] ?? 0
    const end = at[m.index + ref.length - 1] ?? start
    links.push({
      range: { start: { x: start + 1, y }, end: { x: end + 1, y } },
      text: ref,
      activate: () => {
        const p = pane()
        if (p) void openFile(p, ref)
      },
    })
  }
  return links.length ? links : undefined
}

// The pane as plain text, scrollback included: a finger can select it (xterm draws a grid it cannot), and it can be
// searched. The screen shows at once; herdr's copy, with the shell's history above it, replaces it when it comes.
const textView = { pane: null, text: '', query: '', matches: [], at: 0 }

function openTextView(finding = false) {
  const pane = terminal.pane
  if (!pane) return
  const open = !$('#term-text').hidden && textView.pane === pane
  textView.pane = pane
  $('#term-text').hidden = false
  $('[data-term="quote"]').hidden = !isChatPane(pane)
  const input = $('#term-find')
  if (finding) {
    input.focus()
    input.select()
  }
  if (open) return
  showText(terminal.screenText())
  getJson('/api/pane-text', { pane })
    .then(({ text }) => {
      if (textView.pane === pane && !$('#term-text').hidden && text.length > textView.text.length) showText(text)
    })
    .catch(() => {})
}

/** @param {string} text */
function showText(text) {
  textView.text = text
  renderMatches(false)
  const body = $('#term-text-body')
  if (!textView.matches.length) body.scrollTop = body.scrollHeight
}

function closeTextView() {
  $('#term-text').hidden = true
  textView.pane = null
  textView.text = ''
  textView.matches = []
}

// The text with every match marked. `step` moves to the next (1) or previous (-1) match; a new search, or `false`,
// starts again from the last one, nearest the latest output.
function renderMatches(step = 0) {
  const body = $('#term-text-body')
  const query = $('#term-find').value
  const matches = findMatches(textView.text, query)
  if (step === false || query !== textView.query) textView.at = Math.max(0, matches.length - 1)
  else if (matches.length) textView.at = (textView.at + step + matches.length) % matches.length
  textView.query = query
  textView.matches = matches
  const parts = []
  let from = 0
  matches.forEach(([start, end], i) => {
    parts.push(document.createTextNode(textView.text.slice(from, start)))
    const mark = document.createElement('mark')
    mark.className = i === textView.at ? 'term-match is-current' : 'term-match'
    mark.textContent = textView.text.slice(start, end)
    parts.push(mark)
    from = end
  })
  parts.push(document.createTextNode(textView.text.slice(from)))
  body.replaceChildren(...parts)
  $('#term-find-count').textContent = !query
    ? ''
    : matches.length
      ? t('term.findCount', {
          at: textView.at + 1,
          total: `${matches.length}${matches.length >= MAX_MATCHES ? '+' : ''}`,
        })
      : t('term.findNone')
  body.querySelector('.is-current')?.scrollIntoView({ block: 'center' })
}
// What "Quote in message" takes from the text view: the selection in it, else all of it.
function textViewSelection() {
  const selection = window.getSelection()
  const body = $('#term-text-body')
  if (selection && !selection.isCollapsed && body.contains(selection.anchorNode)) return selection.toString()
  return textView.text
}

/** @param {string} text */
function quote(text) {
  if (!text.trim()) return
  document.dispatchEvent(new CustomEvent('herdr:quote', { detail: quoteText(text) }))
}

function hideSelectionChip() {
  $('#term-selection').hidden = true
}

// Selecting with the mouse copies, as in most terminals, and offers to quote the selection in a message.
async function copySelection(x, y) {
  const xterm = terminal.xterm
  if (!xterm?.hasSelection()) return
  const text = xterm.getSelection()
  if (!text.trim() || !(await copyText(text))) return
  const chip = $('#term-selection')
  const view = $('#terminal-view').getBoundingClientRect()
  chip.querySelector('[data-term="quote-selection"]').hidden = !isChatPane(terminal.pane)
  chip.hidden = false
  const left = Math.min(Math.max(8, x - view.left), view.width - chip.offsetWidth - 8)
  const below = y - view.top + 14
  chip.style.left = `${left}px`
  chip.style.top = `${below + chip.offsetHeight > view.height - 8 ? y - view.top - chip.offsetHeight - 14 : below}px`
}

// A second tap on a modifier within this long holds it; a tap on a held one lets it go.
const DOUBLE_TAP_MS = 350
let lastModTap = { name: '', at: 0 }

function tapModifier(name) {
  const now = Date.now()
  const twice = lastModTap.name === name && now - lastModTap.at < DOUBLE_TAP_MS
  lastModTap = { name, at: now }
  const value = terminal.mods[name]
  terminal.setMod(name, value === 0 ? 1 : value === 1 && twice ? 2 : 0)
}

// The input line: what a phone's keyboard writes (a word it suggests, Chinese from an input method) is edited
// there and sent as it reads, then Enter.
const lineMode = () => load('termLine', false) === true

function setLineMode(on) {
  save('termLine', on)
  $('#terminal-view').classList.toggle('is-line', on)
  $('#term-tools [data-term="line"]').setAttribute('aria-pressed', String(on))
}

// Text and Enter go apart: an agent's prompt takes a chunk with a newline in it as pasted, and keeps it.
const LINE_ENTER_DELAY_MS = 60

let lineEnter = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined)

function sendLine(text) {
  const pane = terminal.pane
  if (!pane) return
  terminal.clearMods()
  if (!text) return terminal.input('\r')
  terminal.input(text)
  clearTimeout(lineEnter)
  // Only into the pane the text went to: another pane opened meanwhile may hold text of its own.
  lineEnter = setTimeout(() => {
    if (terminal.pane === pane) terminal.input('\r')
  }, LINE_ENTER_DELAY_MS)
}

export function initTerminal() {
  const el = host()
  let pressed = null
  el.addEventListener('mousedown', e => {
    hideSelectionChip()
    if (terminal.mode === 'closed') terminal.attach(terminal.pane || state.selected)
    pressed = e.button === 0 ? { x: e.clientX, y: e.clientY } : null
  })
  // After xterm has finished the selection the button press ended.
  el.addEventListener('mouseup', e => {
    if (e.button !== 0) return
    const click = !!pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < CLICK_SLOP_PX
    pressed = null
    setTimeout(() => {
      copySelection(e.clientX, e.clientY)
      if (click && !terminal.xterm?.hasSelection()) terminal.click(e.clientX, e.clientY)
    })
  })
  const chip = $('#term-selection')
  chip.addEventListener('mousedown', e => e.preventDefault())
  chip.addEventListener('click', e => {
    if (!e.target.closest('[data-term="quote-selection"]')) return
    quote(terminal.xterm?.getSelection() ?? '')
    terminal.xterm?.clearSelection()
    hideSelectionChip()
  })
  $('#term-takeover').addEventListener('click', () => {
    terminal.ensureControl(true)
    terminal.focus()
  })
  const keys = $('#mobile-keys')
  // Taps on the key row and tools must not take focus from xterm, or the on-screen keyboard closes.
  for (const bar of [keys, $('#term-tools')]) bar.addEventListener('mousedown', e => e.preventDefault())
  keys.addEventListener('click', e => {
    const button = e.target.closest('[data-key]')
    const key = button?.dataset.key
    const mod = button?.dataset.mod
    if (mod) return tapModifier(mod)
    if (key === 'keyboard') {
      // The field can keep focus with the keyboard down (dismissed by the OS, or focused without a tap),
      // and focusing it again shows nothing on iOS: blur first so this tap brings the keyboard up.
      const field = lineMode() ? $('#term-line-input') : terminal.xterm?.textarea
      const focused = document.activeElement === field
      if (focused && isKeyboardUp()) return field.blur()
      if (focused) field.blur()
      return lineMode() ? field.focus() : terminal.focus()
    }
    const sequence = MOBILE_KEYS[key]
    if (sequence) terminal.input(sequence)
  })
  $('#term-line').addEventListener('mousedown', e => {
    if (e.target.closest('button')) e.preventDefault()
  })
  $('#term-line').addEventListener('submit', e => {
    e.preventDefault()
    const input = $('#term-line-input')
    sendLine(input.value)
    input.value = ''
  })
  setLineMode(lineMode())
  $('#term-tools').addEventListener('click', e => {
    const action = e.target.closest('[data-term]')?.dataset.term
    if (action === 'font-down' || action === 'font-up') terminal.stepFont(action === 'font-up' ? 1 : -1)
    else if (action === 'fit') terminal.setWatchView(watchView() === 'fit' ? 'readable' : 'fit')
    else if (action === 'select') openTextView()
    else if (action === 'find') openTextView(true)
    else if (action === 'line') {
      setLineMode(!lineMode())
      if (lineMode()) $('#term-line-input').focus()
    }
  })
  $('#term-text').addEventListener('click', async e => {
    const action = e.target.closest('[data-term]')?.dataset.term
    if (action === 'select-close') {
      closeTextView()
      if (!isNarrow()) terminal.focus()
    } else if (action === 'copy-all') {
      const ok = await copyText(textView.text)
      toast(ok ? t('toast.copied') : t('toast.copyFailed'), '', ok ? '' : 'error')
    } else if (action === 'quote') quote(textViewSelection())
    else if (action === 'find-next' || action === 'find-prev') renderMatches(action === 'find-next' ? 1 : -1)
  })
  let findTimer = null
  $('#term-find').addEventListener('input', () => {
    clearTimeout(findTimer)
    findTimer = setTimeout(() => renderMatches(false), 120)
  })
  $('#term-find').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      clearTimeout(findTimer)
      renderMatches(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeTextView()
      if (!isNarrow()) terminal.focus()
    }
  })
  // xterm redraws its rows, detaching the span a finger is on; touch events keep going to that node and no
  // longer bubble, so follow the gesture on the node it started on.
  el.addEventListener(
    'touchstart',
    e => {
      if (e.touches.length !== 1 || !terminal.xterm) return
      const target = e.target
      let y = e.touches[0].clientY
      const move = ev => {
        const next = ev.touches[0].clientY
        const dy = y - next
        y = next
        // A readable pane taller than the screen pans down to its last row before history scrolls.
        const room = dy > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop
        if (el.classList.contains('is-readable') && room > 0) {
          el.scrollTop += dy
          return
        }
        // Dragging down reveals older output, like scrolling any page.
        terminal.scrollBy(dy, Math.max(12, cellSize(baseFontSize()).height * 1.5))
      }
      const end = () => {
        target.removeEventListener('touchmove', move)
        target.removeEventListener('touchend', end)
        target.removeEventListener('touchcancel', end)
      }
      target.addEventListener('touchmove', move, { passive: true })
      target.addEventListener('touchend', end, { passive: true })
      target.addEventListener('touchcancel', end, { passive: true })
    },
    { passive: true },
  )
  el.addEventListener('dragover', e => {
    e.preventDefault()
    el.classList.add('is-dragging')
  })
  el.addEventListener('dragleave', () => el.classList.remove('is-dragging'))
  el.addEventListener('drop', async e => {
    e.preventDefault()
    el.classList.remove('is-dragging')
    const paths = await uploadFiles([...(e.dataTransfer?.files ?? [])])
    if (paths.length) terminal.paste(`${paths.join(' ')} `)
  })
  let resizeTimer = null
  new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => terminal.refit(), 120)
  }).observe(el)
  narrowQuery.addEventListener('change', () => terminal.refit())
  onThemeChange(() => {
    if (terminal.xterm) terminal.xterm.options.theme = terminalTheme()
  })
}
