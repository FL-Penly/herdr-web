import { describe, expect, test } from 'bun:test'
import { parseDialog } from '../../src/tui/dialog.ts'
import { TuiError, arrowKeys, clearInputKeys, createDriver, isRestoredPrompt } from '../../src/tui/driver.ts'
import { claudeBox, screen } from './fixtures.ts'

type Call = ['keys', string[]] | ['text', string] | ['sleep', number]

/** A fake pane: each readScreen returns the next screen (the last one repeats); every action is logged. */
function fakePane(...screens: string[]) {
  const calls: Call[] = []
  let reads = 0
  const read = async () => screens[Math.min(reads++, screens.length - 1)] ?? ''
  const driver = createDriver({
    readScreen: read,
    readStyled: read,
    sendKeys: async (_pane, keys) => calls.push(['keys', keys]),
    sendText: async (_pane, text) => calls.push(['text', text]),
    sleep: async ms => {
      calls.push(['sleep', ms])
    },
  })
  return { driver, calls }
}

const idleBox = (...input: string[]) => claudeBox(input, ['  ? for shortcuts'])

describe('key helpers', () => {
  test('arrowKeys', () => {
    expect(arrowKeys(0, 2)).toEqual(['down', 'down'])
    expect(arrowKeys(2, 1)).toEqual(['up'])
    expect(arrowKeys(1, 1)).toEqual([])
  })

  test('clearInputKeys: no trailing backspace', () => {
    expect(clearInputKeys(1)).toEqual(['ctrl+u'])
    expect(clearInputKeys(3)).toEqual(['ctrl+u', 'backspace', 'ctrl+u', 'backspace', 'ctrl+u'])
    expect(clearInputKeys(0)).toEqual([])
  })

  test('isRestoredPrompt: the box shows a prefix of the prompt, or all of it', () => {
    expect(isRestoredPrompt(['fix the', 'parser'], 'fixtheparserandaddtests')).toBe(true)
    expect(isRestoredPrompt(['fix the parser and add tests now'], 'fixtheparserandadd')).toBe(true)
    expect(isRestoredPrompt(['something else'], 'fixtheparser')).toBe(false)
    expect(isRestoredPrompt([], 'fixtheparser')).toBe(false)
  })
})

describe('chooseOption', () => {
  const PERMISSION_Q =
    'rm -rf build && npm test\nRemove the build output and run the test suite\nDo you want to proceed?'

  test('digit keys move from the cursor with arrows (never the digit itself)', async () => {
    const { driver, calls } = fakePane(screen('codex-trust'))
    await driver.chooseOption('p', { key: '2', label: 'No, quit', blocked: true })
    expect(calls).toEqual([['keys', ['down', 'enter']]])
  })

  test('choosing the already-selected option just presses Enter', async () => {
    const { driver, calls } = fakePane(screen('codex-trust'))
    await driver.chooseOption('p', { key: '1', label: 'Yes, continue', blocked: true })
    expect(calls).toEqual([['keys', ['enter']]])
  })

  test('arrow menus move from the cursor as it is now, not as it was when the option was shown', async () => {
    const model = screen('claude-model-menu')
    const { driver, calls } = fakePane(model)
    const { options } = parseDialog(model)
    const cur = options.findIndex(o => o.current)
    const target = options[cur + 1] ?? options[cur - 1]
    if (!target) throw new Error('fixture has one option')
    // The browser saw this option two rows away; the screen has it one row from the cursor now.
    await driver.chooseOption('p', { key: 'nav:2', label: target.label })
    expect(calls).toEqual([['keys', [options[cur + 1] ? 'down' : 'up', 'enter']]])
  })

  test('a stale click sends nothing: no dialog, another question, or an option that is gone', async () => {
    const composer = fakePane(idleBox('draft text'))
    await expect(composer.driver.chooseOption('p', { key: 'nav:1', label: 'Sonnet' })).rejects.toMatchObject({
      code: 'stale_dialog',
    })
    const permission = screen('claude-permission')
    const other = fakePane(permission)
    await expect(
      other.driver.chooseOption('p', {
        key: '1',
        label: 'Yes',
        question: 'Do you want to make this edit?',
        blocked: true,
      }),
    ).rejects.toMatchObject({ code: 'stale_dialog' })
    await expect(
      other.driver.chooseOption('p', { key: '4', label: 'Yes, always', question: PERMISSION_Q, blocked: true }),
    ).rejects.toMatchObject({ code: 'stale_dialog' })
    expect([composer.calls, other.calls]).toEqual([[], []])
  })

  test('the same question re-wrapped still matches', async () => {
    const { driver, calls } = fakePane(screen('claude-permission'))
    await driver.chooseOption('p', {
      key: '3',
      label: 'No, and tell Claude what to do differently (esc)',
      question: PERMISSION_Q.replaceAll('\n', ' '),
      blocked: true,
    })
    expect(calls).toEqual([['keys', ['down', 'down', 'enter']]])
  })

  test('a permission prompt whose command changed further down is another dialog', async () => {
    const staging = screen('codex-approval')
    const asked = parseDialog(staging).question
    const yes = { key: '1', label: 'Yes, proceed (y)', question: asked, blocked: true }
    // The reviewer's mutation: same reason, same first 40 characters, another environment.
    const production = fakePane(staging.replace('--env staging', '--env production'))
    await expect(production.driver.chooseOption('p', yes)).rejects.toMatchObject({ code: 'stale_dialog' })
    expect(production.calls).toEqual([])
    const same = fakePane(staging)
    await same.driver.chooseOption('p', yes)
    expect(same.calls).toEqual([['keys', ['enter']]])
  })

  test('the top row of a long command is compared too', async () => {
    const long = (first: string) =>
      screen('claude-permission').replace(
        '   rm -rf build && npm test\n',
        `   ${first}\n${Array.from({ length: 12 }, (_, i) => `     step ${i}\n`).join('')}`,
      )
    const asked = parseDialog(long('cd /srv/staging &&')).question
    expect(asked.startsWith('cd /srv/staging &&')).toBe(true)
    const { driver, calls } = fakePane(long('cd /srv/production &&'))
    await expect(
      driver.chooseOption('p', { key: '1', label: 'Yes', question: asked, blocked: true }),
    ).rejects.toMatchObject({ code: 'stale_dialog' })
    expect(calls).toEqual([])
  })

  test('an empty question asked is checked, a missing one is not', async () => {
    await expect(
      fakePane(screen('claude-permission')).driver.chooseOption('p', {
        key: '1',
        label: 'Yes',
        question: '',
        blocked: true,
      }),
    ).rejects.toMatchObject({ code: 'stale_dialog' })
    const { driver, calls } = fakePane(screen('claude-permission'))
    await driver.chooseOption('p', { key: '1', label: 'Yes', blocked: true })
    expect(calls).toEqual([['keys', ['enter']]])
  })

  test('Submit answers: checked against the answers the browser showed', async () => {
    const question = 'Favorite color? → Red\nFavorite fruit? → Pear\nReady to submit your answers?'
    const stale = fakePane(screen('claude-ask-form-review'))
    await expect(
      stale.driver.chooseOption('p', {
        key: '1',
        label: 'Submit answers',
        question: question.replace('Pear', 'Apple'),
        blocked: true,
      }),
    ).rejects.toMatchObject({ code: 'stale_dialog' })
    const { driver, calls } = fakePane(screen('claude-ask-form-review'))
    await driver.chooseOption('p', { key: '1', label: 'Submit answers', question, blocked: true })
    expect(calls).toEqual([['keys', ['enter']]])
  })

  test('Type something: move, type, Enter', async () => {
    const { driver, calls } = fakePane(screen('claude-ask-user-question'))
    await driver.chooseOption('p', { key: '3', label: 'Type something.', text: 'MySQL please', blocked: true })
    expect(calls).toEqual([
      ['keys', ['down', 'down']],
      ['sleep', 200],
      ['text', 'MySQL please'],
      ['sleep', 200],
      ['keys', ['enter']],
    ])
  })

  test('Codex None of the above: free text goes into the notes field Tab opens', async () => {
    const { driver, calls } = fakePane(screen('codex-sync-question'))
    await driver.chooseOption('p', { key: '3', label: 'None of the above', text: 'MySQL please', blocked: true })
    expect(calls).toEqual([
      ['keys', ['down', 'down']],
      ['sleep', 200],
      ['keys', ['tab']],
      ['sleep', 200],
      ['text', 'MySQL please'],
      ['sleep', 200],
      ['keys', ['enter']],
    ])
  })

  test('no cursor on screen: the shown digit is sent only while blocked', async () => {
    const noCursor = screen('codex-trust').replace('› 1.', '  1.')
    const { driver, calls } = fakePane(noCursor)
    await driver.chooseOption('p', { key: '2', label: 'No, quit', blocked: true })
    expect(calls).toEqual([['keys', ['2']]])
    await expect(driver.chooseOption('p', { key: '2', label: 'No, quit' })).rejects.toBeInstanceOf(TuiError)
    await expect(driver.chooseOption('p', { key: '2', label: 'No, quit', blocked: true })).resolves.toBeUndefined()
    const empty = fakePane('')
    await expect(empty.driver.chooseOption('p', { key: '2', label: 'No', blocked: true })).rejects.toMatchObject({
      code: 'stale_dialog',
    })
  })

  test('a failed screen read is reported, not mistaken for a closed dialog', async () => {
    const driver = createDriver({
      readScreen: () => Promise.reject(new Error('herdr down')),
      readStyled: () => Promise.reject(new Error('herdr down')),
      sendKeys: async () => {},
      sendText: async () => {},
      sleep: async () => {},
    })
    await expect(driver.chooseOption('p', { key: '2', label: 'No', blocked: true })).rejects.toThrow('herdr down')
  })
})

describe('answerAsyncQuestion', () => {
  const panel = screen('codex-async-panel')
  const other = panel.replace('Which environment should the release go to?', 'Which region hosts the database?')

  test('opens the panel, steps to the question, picks the option', async () => {
    const { driver, calls } = fakePane(screen('codex-async-pending'), other, panel)
    await driver.answerAsyncQuestion('p', 'Which environment should the release go to?', { option: 'Production' })
    expect(calls).toEqual([
      ['keys', ['shift+left']],
      ['sleep', 500],
      ['keys', ['shift+left']],
      ['sleep', 350],
      ['keys', ['down', 'enter']],
    ])
  })

  test('Other is typed inline', async () => {
    const { driver, calls } = fakePane(panel)
    await driver.answerAsyncQuestion('p', 'Which environment should the release go to?', { text: 'canary' })
    expect(calls).toEqual([
      ['keys', ['down', 'down']],
      ['sleep', 200],
      ['text', 'canary'],
      ['sleep', 200],
      ['keys', ['enter']],
    ])
  })

  test('a question that only starts like the one asked is not it', async () => {
    const longer = panel.replace(
      'Which environment should the release go to?',
      'Which environment should the release go to after the freeze?',
    )
    const { driver, calls } = fakePane(longer)
    await expect(
      driver.answerAsyncQuestion('p', 'Which environment should the release go to?', { option: 'Production' }),
    ).rejects.toMatchObject({ code: 'question_not_found' })
    expect(calls.some(c => c[0] === 'keys' && c[1].includes('enter'))).toBe(false)
  })

  test('errors: question never shows, option missing', async () => {
    const lost = fakePane(other)
    await expect(
      lost.driver.answerAsyncQuestion('p', 'Which environment?', { option: 'Staging' }),
    ).rejects.toMatchObject({
      code: 'question_not_found',
    })
    expect(lost.calls.filter(c => c[0] === 'keys')).toHaveLength(8)
    const { driver } = fakePane(panel)
    await expect(
      driver.answerAsyncQuestion('p', 'Which environment should the release go to?', { option: 'Mars' }),
    ).rejects.toMatchObject({ code: 'option_not_found' })
  })
})

describe('prepareReply', () => {
  test('Codex question panel: back to the main prompt', async () => {
    const { driver, calls } = fakePane(screen('codex-async-panel'))
    await driver.prepareReply('p')
    expect(calls).toEqual([
      ['keys', ['shift+right']],
      ['sleep', 250],
    ])
  })

  test('a dialog with options: Esc', async () => {
    const { driver, calls } = fakePane(screen('claude-permission'))
    await driver.prepareReply('p')
    expect(calls[0]).toEqual(['keys', ['esc']])
  })

  test('nothing to dismiss', async () => {
    const { driver, calls } = fakePane(screen('claude-idle-spoof'))
    await driver.prepareReply('p')
    expect(calls).toEqual([])
  })
})

describe('showInputBox', () => {
  test('the input box on screen: nothing to do', async () => {
    const { driver, calls } = fakePane(idleBox())
    await driver.showInputBox('p', { escape: true })
    expect(calls).toEqual([])
  })

  test('/config left open with its search field: Esc until the input box is back', async () => {
    const { driver, calls } = fakePane(screen('claude-config-panel'), screen('claude-config-panel'), idleBox())
    await driver.showInputBox('p', { escape: true })
    expect(calls).toEqual([
      ['keys', ['esc']],
      ['sleep', 250],
      ['keys', ['esc']],
      ['sleep', 250],
    ])
  })

  test('a working agent is never sent Esc, which would stop its turn', async () => {
    const { driver, calls } = fakePane(screen('claude-config-panel'))
    await expect(driver.showInputBox('p', { escape: false })).rejects.toMatchObject({ code: 'no_input_box' })
    expect(calls).toEqual([])
  })

  test('gives up after three Esc presses', async () => {
    const { driver, calls } = fakePane(screen('claude-status-panel'))
    await expect(driver.showInputBox('p', { escape: true })).rejects.toMatchObject({ code: 'no_input_box' })
    expect(calls.filter(c => c[0] === 'keys')).toHaveLength(3)
  })
})

describe('interruptAndRestore', () => {
  test('clears the restored prompt so the web composer can take it', async () => {
    const { driver, calls } = fakePane(idleBox('please refactor the dialog', 'parser now'))
    const r = await driver.interruptAndRestore('p', 'please refactor the dialog parser now')
    expect(r).toEqual({ restored: true })
    expect(calls).toEqual([
      ['keys', ['esc']],
      ['sleep', 400],
      ['keys', ['ctrl+u', 'backspace', 'ctrl+u']],
    ])
  })

  test('waits for the redraw, then gives up', async () => {
    const { driver, calls } = fakePane(idleBox(), idleBox('unrelated draft'))
    expect(await driver.interruptAndRestore('p', 'please refactor')).toEqual({ restored: false })
    expect(calls).toEqual([
      ['keys', ['esc']],
      ['sleep', 400],
      ['sleep', 700],
    ])
  })

  test('without a last prompt only Esc is sent', async () => {
    const { driver, calls } = fakePane()
    expect(await driver.interruptAndRestore('p', '  ')).toEqual({ restored: false })
    expect(calls).toEqual([['keys', ['esc']]])
  })
})

describe('interrupt and clearInput', () => {
  test('interrupt sends Esc and lets the TUI settle', async () => {
    const { driver, calls } = fakePane(idleBox(''))
    await driver.interrupt('p')
    expect(calls).toEqual([
      ['keys', ['esc']],
      ['sleep', 400],
    ])
  })

  test('clearInput empties every row of the box, and does nothing without one', async () => {
    const full = fakePane(idleBox('/goal clear', 'queued follow-up'))
    await full.driver.clearInput('p')
    expect(full.calls).toEqual([
      ['keys', ['ctrl+u', 'backspace', 'ctrl+u']],
      ['sleep', 150],
    ])
    const dialog = fakePane(screen('codex-trust'))
    await dialog.driver.clearInput('p')
    expect(dialog.calls).toEqual([])
  })
})

describe('inputDraft and discardDraft', () => {
  test('a draft is what was typed, not the placeholder', async () => {
    expect(await fakePane(screen('ansi/claude-draft')).driver.inputDraft('p')).toBe('fix the parser\nand R5LEFT__RIGHT')
    expect(await fakePane(screen('ansi/codex-placeholder')).driver.inputDraft('p')).toBe('')
  })

  test('the box is emptied from its last row up, whatever the cursor, and checked', async () => {
    const { driver, calls } = fakePane(screen('ansi/claude-draft'), screen('ansi/claude-placeholder'))
    await driver.discardDraft('p')
    expect(calls).toEqual([
      ['keys', ['down', 'down', 'ctrl+e', 'ctrl+u', 'backspace', 'ctrl+u']],
      ['sleep', 150],
    ])
    const codex = fakePane(screen('ansi/codex-draft'), screen('ansi/codex-placeholder'))
    await codex.driver.discardDraft('p')
    expect(codex.calls[0]).toEqual(['keys', ['down', 'down', 'ctrl+e', 'ctrl+u', 'backspace', 'ctrl+u']])
  })

  test('a box left half-cleared is cleared again; one that stays full fails with its text', async () => {
    const twice = fakePane(idleBox('one', 'two'), idleBox('', 'two'), idleBox())
    await twice.driver.discardDraft('p')
    expect(twice.calls.filter(c => c[0] === 'keys').length).toBe(2)
    const stuck = fakePane(idleBox('stuck'))
    await expect(stuck.driver.discardDraft('p')).rejects.toMatchObject({
      code: 'terminal_draft',
      data: { draft: 'stuck' },
    })
    expect(stuck.calls.filter(c => c[0] === 'keys').length).toBe(3)
    // Nothing typed: nothing sent.
    const empty = fakePane(idleBox())
    await empty.driver.discardDraft('p')
    expect(empty.calls).toEqual([])
  })
})
