import { parseDialog } from './dialog.ts'
import { JUMP_NOTE_RE, SCROLL_TO_END, SCROLL_UP, revealedDialog } from './reveal.ts'
import {
  hasInputBox,
  hasMainPromptHint,
  inputDraft,
  inputLines,
  isAsyncPanelOpen,
  sameText,
  squeeze,
} from './screen.ts'

// Key sequences that drive a live Claude Code / Codex TUI. The pauses give the TUI time to redraw
// before the next key or screen read; the values were tuned against real Claude Code and Codex panes.
const DELAY = {
  /** After moving the cursor, before typing into an inline `Other` field (and after typing, before Enter). */
  typeSettle: 200,
  /** After closing a dialog or leaving the Codex question panel, before sending a prompt. */
  dialogClose: 250,
  /** After opening the Codex async-question panel. */
  panelOpen: 500,
  panelStep: 350,
  /** Re-reads of the input box after Esc, waiting for the interrupted prompt to be restored. */
  restoreChecks: [400, 700],
  /** After Esc, for the TUI to abort the turn and write that down. */
  interruptSettle: 400,
  /** After clearing the input box, before typing into it. */
  inputClear: 150,
  /** After PageUp or ctrl+End, for Claude Code to redraw its scrolled view. */
  scroll: 250,
} as const
/** Esc presses that may close what covers the input box: a settings panel's search field, then the panel. */
const PANEL_ESCAPES = 3

// PageUp moves Claude Code's view about half a screen: this reads a preview of roughly 400 rows.
const MAX_REVEAL_PAGES = 20
const REVEAL_SETTLE_READS = 4

// Each round empties the input box from its last row up; a second one catches a TUI that redrew late.
const DISCARD_ROUNDS = 3
const MAX_PANEL_STEPS = 8
const RESTORE_MATCH_CHARS = 40
/** The row Codex's async-question panel puts above the question: `Question 1/2 · <header>`. */
const ASYNC_HEADER_RE = /^(?:Question|问题)\s*\d+\s*\/\s*\d+\b/
const OTHER_RE = /^(Other|其他)/i
// Codex's `None of the above` row takes free text only in a notes field that Tab opens.
const NOTES_RE = /notes \(tab\)/i

export type TuiErrorCode =
  | 'stale_dialog'
  | 'question_not_found'
  | 'option_not_found'
  | 'terminal_draft'
  | 'no_input_box'

export class TuiError extends Error {
  constructor(
    readonly code: TuiErrorCode,
    message: string,
    /** Sent back with the error (`terminal_draft`: `{draft}`). */
    readonly data: { draft?: string } = {},
  ) {
    super(message)
    this.name = 'TuiError'
  }
}

export interface PaneIO {
  readScreen(pane: string): Promise<string>
  /** The screen with its colors and attributes (`herdr pane read --ansi`). */
  readStyled(pane: string): Promise<string>
  sendKeys(pane: string, keys: string[]): Promise<unknown>
  sendText(pane: string, text: string): Promise<unknown>
  sleep(ms: number): Promise<void>
}

/** The option the user clicked, as the browser saw it: identified by its label, not by its position. */
export interface ChooseOptions {
  /** The option's key when it was shown, only used to tell apart options with the same label. */
  key: string
  label: string
  /** The dialog's question when it was shown; the option is picked only if the screen still asks it. */
  question?: string | null
  /** Typed into the chosen row (an inline `Other` field or Codex's notes field). */
  text?: string | null
  /** herdr reports the agent `blocked`: a bare digit may be sent when no cursor is on screen. */
  blocked?: boolean
}

/** Pick `option` by its label, or type `text` into the inline `Other` row. */
export interface AsyncAnswer {
  option?: string | null
  text?: string | null
}

export function arrowKeys(from: number, to: number): string[] {
  return Array<string>(Math.abs(to - from)).fill(to < from ? 'up' : 'down')
}

/** ctrl+u empties a row and backspace joins it to the one above; no backspace after the last row. */
export function clearInputKeys(rows: number): string[] {
  return Array.from({ length: rows }, () => ['ctrl+u', 'backspace'])
    .flat()
    .slice(0, -1)
}

/**
 * Whether the dialog on screen still asks what the browser showed, all of it: a permission prompt that differs
 * only in its command or target further down is another dialog. Without `asked` nothing is checked.
 */
export function sameQuestion(shown: string, asked: string | null | undefined): boolean {
  return asked == null || sameText(shown, asked)
}

/** Whether Codex's async-question panel shows the question titled `title` (under its `Question n/m` row). */
export function showsAsyncQuestion(shown: string, title: string): boolean {
  if (!squeeze(title)) return false
  const [first = '', ...rest] = shown.split('\n')
  return sameText(shown, title) || (ASYNC_HEADER_RE.test(first.trim()) && sameText(rest.join('\n'), title))
}

/** `want` is the squeezed start of the sent prompt; the box may show a prefix of it or all of it. */
export function isRestoredPrompt(rows: string[], want: string): boolean {
  if (!rows.length) return false
  const shown = squeeze(rows.join(''))
  return want.startsWith(shown.slice(0, RESTORE_MATCH_CHARS)) || shown.startsWith(want)
}

// A failed screen read propagates as HerdrError: the keys to send depend on what is on screen.
export function createDriver(io: PaneIO) {
  /**
   * Arrow keys from option `from` to option `to`, then Enter; with `text`, type it into that row first
   * (into its notes field when `notes` is set).
   */
  async function pickOption(
    pane: string,
    from: number,
    to: number,
    { text = null, notes = false }: { text?: string | null; notes?: boolean } = {},
  ): Promise<void> {
    const moves = arrowKeys(from, to)
    if (text == null) {
      await io.sendKeys(pane, [...moves, 'enter'])
      return
    }
    if (moves.length) await io.sendKeys(pane, moves)
    await io.sleep(DELAY.typeSettle)
    if (notes) {
      await io.sendKeys(pane, ['tab'])
      await io.sleep(DELAY.typeSettle)
    }
    await io.sendText(pane, text)
    await io.sleep(DELAY.typeSettle)
    await io.sendKeys(pane, ['enter'])
  }

  /**
   * Choose the option labelled `label` of the dialog or menu on screen now. The screen is re-read and the
   * keys are worked out from its current cursor: a click from an older poll would otherwise land on another
   * row, or on another dialog that opened since. Codex acts on a digit at once, but pressing the digit of
   * the already-selected row does nothing, so digits move with arrows too. Without a cursor on screen the
   * digit is sent as-is, which only makes sense while herdr reports the agent `blocked`.
   */
  async function chooseOption(
    pane: string,
    { key, label, question = null, text = null, blocked = false }: ChooseOptions,
  ): Promise<void> {
    const dialog = parseDialog(await io.readScreen(pane))
    const { options } = dialog
    const stale = () => new TuiError('stale_dialog', 'This dialog changed since it was shown')
    if (!options.length) throw stale()
    if (!sameQuestion(dialog.question, question)) throw stale()
    const matches = options.flatMap((o, i) => (o.label === label ? [i] : []))
    const to = matches.find(i => options[i]?.key === key) ?? (matches.length === 1 ? matches[0] : undefined)
    const target = to === undefined ? undefined : options[to]
    if (to === undefined || !target) throw stale()
    const from = options.findIndex(o => o.current)
    if (from >= 0) return pickOption(pane, from, to, { text, notes: NOTES_RE.test(target.desc ?? '') })
    if (blocked && /^\d{1,2}$/.test(target.key)) {
      await io.sendKeys(pane, [target.key])
      return
    }
    throw stale()
  }

  /**
   * Answer one of Codex's async questions: open the question panel (shift+←), step through the queued
   * questions until `question` shows, then pick `option`, or type `text` into its inline `Other` row.
   */
  async function answerAsyncQuestion(
    pane: string,
    question: string,
    { option = null, text = null }: AsyncAnswer,
  ): Promise<void> {
    let screen = await io.readScreen(pane)
    if (!isAsyncPanelOpen(screen)) {
      await io.sendKeys(pane, ['shift+left'])
      await io.sleep(DELAY.panelOpen)
      screen = await io.readScreen(pane)
    }
    const showing = () => showsAsyncQuestion(parseDialog(screen).question, question)
    for (let i = 0; i < MAX_PANEL_STEPS && !showing(); i++) {
      await io.sendKeys(pane, ['shift+left'])
      await io.sleep(DELAY.panelStep)
      screen = await io.readScreen(pane)
    }
    if (!showing()) throw new TuiError('question_not_found', 'This question is not on the terminal screen')
    const { options } = parseDialog(screen)
    const from = options.findIndex(o => o.current)
    const to =
      text != null ? options.findIndex(o => OTHER_RE.test(o.label)) : options.findIndex(o => o.label === option)
    if (from < 0 || to < 0) throw new TuiError('option_not_found', 'This option is not on the terminal screen')
    await pickOption(pane, from, to, { text })
  }

  /**
   * Get a blocked agent ready for a typed prompt: leave Codex's question panel for the main prompt
   * (shift+→), or dismiss a dialog with options (Esc). Anything else is left alone.
   */
  async function prepareReply(pane: string): Promise<void> {
    const screen = await io.readScreen(pane)
    if (hasMainPromptHint(screen)) await io.sendKeys(pane, ['shift+right'])
    else if (parseDialog(screen).options.length) await io.sendKeys(pane, ['esc'])
    else return
    await io.sleep(DELAY.dialogClose)
  }

  /**
   * Interrupt with Esc. Both TUIs then put the interrupted prompt back into the input box; when it
   * matches `last` (what the web UI sent), clear it so the web composer can restore it instead. The
   * interrupt is already sent, so a failed read only means nothing was restored.
   */
  async function interruptAndRestore(pane: string, last: string): Promise<{ restored: boolean }> {
    await io.sendKeys(pane, ['esc'])
    const want = squeeze(last).slice(0, RESTORE_MATCH_CHARS)
    if (!want) return { restored: false }
    for (const wait of DELAY.restoreChecks) {
      await io.sleep(wait)
      const rows = inputLines(await io.readScreen(pane).catch(() => ''))
      if (!isRestoredPrompt(rows, want)) continue
      await io.sendKeys(pane, clearInputKeys(rows.length))
      return { restored: true }
    }
    return { restored: false }
  }

  /**
   * Bring the input box back before typing into it: a panel (`/config`, `/mcp`) or a menu over it would take
   * the text instead. Esc closes one, a search field in it first, so up to PANEL_ESCAPES of them, reading the
   * screen after each. Without `escape` (a working agent, where Esc would stop the turn) nothing is pressed.
   * Fails with `no_input_box` when the box does not come back.
   */
  async function showInputBox(pane: string, o: { escape: boolean }): Promise<void> {
    for (let pressed = 0; ; pressed++) {
      if (hasInputBox(await io.readScreen(pane))) return
      if (!o.escape || pressed === PANEL_ESCAPES) break
      await io.sendKeys(pane, ['esc'])
      await io.sleep(DELAY.dialogClose)
    }
    throw new TuiError('no_input_box', 'Something open in the terminal covers the input box; close it there first')
  }

  /** Interrupt with Esc and give the TUI a moment to abort the turn. */
  async function interrupt(pane: string): Promise<void> {
    await io.sendKeys(pane, ['esc'])
    await io.sleep(DELAY.interruptSettle)
  }

  /**
   * Empty the input box, so a prompt typed next is not appended to text left there (Claude Code puts
   * interrupted and queued prompts back into it). A placeholder reads like text, but clearing it is a no-op.
   */
  async function clearInput(pane: string): Promise<void> {
    const rows = inputLines(await io.readScreen(pane))
    if (!rows.length) return
    await io.sendKeys(pane, clearInputKeys(rows.length))
    await io.sleep(DELAY.inputClear)
  }

  /** What was typed into the agent's input box and not sent: '' when it is empty or not on screen. */
  async function draft(pane: string): Promise<string> {
    return inputDraft(await io.readStyled(pane))
  }

  /**
   * Empty the input box wherever its cursor is: down to its last row (on the last row down does nothing, or
   * steps through the prompt history, which is thrown away too; up would recall history into it), ctrl+e,
   * then ctrl+u and backspace from there up. Re-read until it is empty; fails with `terminal_draft` if not.
   */
  async function discardDraft(pane: string): Promise<void> {
    let left = await draft(pane)
    for (let i = 0; i < DISCARD_ROUNDS && left; i++) {
      const rows = left.split('\n').length
      await io.sendKeys(pane, [...Array<string>(rows).fill('down'), 'ctrl+e', ...clearInputKeys(rows)])
      await io.sleep(DELAY.inputClear)
      left = await draft(pane)
    }
    if (left)
      throw new TuiError('terminal_draft', 'The text in the terminal input could not be cleared', { draft: left })
  }

  /**
   * The whole of the dialog on screen when it asks `question`, its top included: a file or diff taller than the
   * pane shows only its end, so Claude Code's view is paged up until the dialog's top rule shows, then sent back
   * to the bottom. PageUp and ctrl+End only move the view: the dialog stays open with its cursor where it was.
   * Null when the top was not reached, or the dialog is no longer the same when the view is back.
   */
  async function revealDialog(pane: string, question: string): Promise<string | null> {
    const screen = await io.readScreen(pane)
    const asks = (s: string) => {
      const dialog = parseDialog(s)
      return dialog.options.length > 0 && sameQuestion(dialog.question, question)
    }
    if (!asks(screen)) throw new TuiError('stale_dialog', 'This dialog changed since it was shown')
    const pages = [screen]
    let text = revealedDialog(pages)
    if (text !== undefined) return text
    try {
      for (let i = 0; i < MAX_REVEAL_PAGES && text === undefined; i++) {
        await io.sendText(pane, SCROLL_UP)
        await io.sleep(DELAY.scroll)
        const page = await io.readScreen(pane)
        // The view did not move: it is at the top already, or the TUI does not scroll.
        if (page === pages.at(-1)) break
        pages.push(page)
        text = revealedDialog(pages)
      }
    } finally {
      await io.sendText(pane, SCROLL_TO_END)
      await io.sleep(DELAY.scroll)
    }
    // The view redraws over a few frames: the dialog counts as back once the screen asks the question again.
    let back = await io.readScreen(pane)
    for (let i = 0; i < REVEAL_SETTLE_READS && !asks(back); i++) {
      if (JUMP_NOTE_RE.test(back)) await io.sendText(pane, SCROLL_TO_END)
      await io.sleep(DELAY.scroll)
      back = await io.readScreen(pane)
    }
    return text && asks(back) ? text : null
  }

  return {
    chooseOption,
    answerAsyncQuestion,
    prepareReply,
    showInputBox,
    interruptAndRestore,
    interrupt,
    clearInput,
    revealDialog,
    inputDraft: draft,
    discardDraft,
  }
}

export type Driver = ReturnType<typeof createDriver>
