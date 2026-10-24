import { beforeAll, describe, expect, test } from 'bun:test'
import { installMemoryStorage } from './memory-storage.ts'

const data = installMemoryStorage()
// sends.js reads the persisted list when it is first imported, after the storage above exists.
const sends = await import('../../public/js/sends.js')

const failure = {
  selected: true,
  draft: '',
  composerAttachments: 0,
  typed: 'Original unsent message',
  attachments: [] as string[],
  text: 'Original unsent message',
  restore: true,
}

describe('a reply that failed', () => {
  test('goes back into the open composer when it is still empty, with its attachments', () => {
    const attachments = ['/tmp/uploads/a.png']
    expect(
      sends.recoverFailedSend({ ...failure, attachments, text: 'Original unsent message\n/tmp/uploads/a.png' }),
    ).toEqual({ to: 'composer', typed: 'Original unsent message', attachments })
  })

  test('never overwrites a draft typed while it was in flight', () => {
    expect(sends.recoverFailedSend({ ...failure, draft: 'Newer draft while request is pending' })).toEqual({
      to: 'card',
    })
    expect(sends.recoverFailedSend({ ...failure, composerAttachments: 1 })).toEqual({ to: 'card' })
  })

  test('is kept for its own pane after switching away: into its empty draft, or as a card', () => {
    const away = { ...failure, selected: false, text: 'Lost original after switching pane\n/tmp/u/b.txt' }
    expect(sends.recoverFailedSend(away)).toEqual({
      to: 'draft',
      text: 'Lost original after switching pane\n/tmp/u/b.txt',
    })
    expect(sends.recoverFailedSend({ ...away, draft: 'something else' })).toEqual({ to: 'card' })
    // The open composer's attachments belong to another pane.
    expect(sends.recoverFailedSend({ ...away, composerAttachments: 2 }).to).toBe('draft')
  })

  test('sent again from a card stays on a card', () => {
    expect(sends.recoverFailedSend({ ...failure, restore: false })).toEqual({ to: 'card' })
  })
})

describe('failed-send cards', () => {
  beforeAll(() => {
    for (const f of sends.failedSendsFor('w1:p1')) sends.removeFailedSend(f.id)
  })

  test('are kept per pane and persisted', () => {
    const a = sends.addFailedSend('w1:p1', 'first', 1)
    sends.addFailedSend('w1:p2', 'other pane', 2)
    expect(sends.failedSendsFor('w1:p1').map(f => f.text)).toEqual(['first'])
    expect(JSON.parse(data.get('herdr-web:failedSends') ?? '[]')).toHaveLength(2)
    expect(sends.removeFailedSend(a.id)?.text).toBe('first')
    expect(sends.removeFailedSend(a.id)).toBeNull()
    expect(sends.failedSendsFor('w1:p1')).toEqual([])
  })

  test('the same text failing twice is one card', () => {
    sends.addFailedSend('w1:p3', 'again', 1)
    sends.addFailedSend('w1:p3', 'again', 2)
    expect(sends.failedSendsFor('w1:p3')).toHaveLength(1)
  })

  test('are bounded and forgotten with their pane', () => {
    for (let i = 0; i < 30; i++) sends.addFailedSend('w1:p4', `m${i}`, i)
    expect(sends.failedSendsFor('w1:p4').length).toBe(10)
    expect(sends.failedSendsFor('w1:p4').at(-1)?.text).toBe('m29')
    sends.pruneFailedSends(new Set(['w1:p2']))
    expect(sends.failedSendsFor('w1:p4')).toEqual([])
    expect(sends.failedSendsFor('w1:p2')).toHaveLength(1)
  })

  test('request ids are unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => sends.sendId()))
    expect(ids.size).toBe(100)
  })
})

describe('a reply into a terminal that holds a draft', () => {
  const draftError = (draft: string) => Object.assign(new Error('draft'), { code: 'terminal_draft', data: { draft } })

  test('sends the draft that was shown, and asks again when the terminal changed meanwhile', async () => {
    const terminal = ['R6_OLD_DRAFT', 'R6_NEW_UNSEEN_DRAFT']
    const sent: (string | undefined)[] = []
    const shown: string[] = []
    const result = await sends.sendReplacingDraft(
      async discardDraft => {
        sent.push(discardDraft)
        const draft = terminal.shift()
        if (draft !== undefined && draft !== discardDraft) throw draftError(draft)
        return { ok: true }
      },
      async draft => {
        shown.push(draft)
        return true
      },
    )
    expect(result).toEqual({ sent: { ok: true } })
    expect(shown).toEqual(['R6_OLD_DRAFT', 'R6_NEW_UNSEEN_DRAFT'])
    expect(sent).toEqual([undefined, 'R6_OLD_DRAFT', 'R6_NEW_UNSEEN_DRAFT'])
  })

  test('declining the newer draft sends nothing more', async () => {
    let calls = 0
    const answers = [true, false]
    const result = await sends.sendReplacingDraft(
      async () => {
        calls++
        throw draftError(`draft ${calls}`)
      },
      async () => answers.shift() ?? false,
    )
    expect(result).toEqual({ declined: true })
    expect(calls).toBe(2)
  })

  test('other failures are thrown as they are', async () => {
    const boom = Object.assign(new Error('gone'), { code: 'no_agent' })
    await expect(
      sends.sendReplacingDraft(
        async () => {
          throw boom
        },
        async () => true,
      ),
    ).rejects.toBe(boom)
  })
})
