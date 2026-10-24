import { expect, test } from 'bun:test'
import { HerdrError } from '../../src/herdr.ts'
import { UserError, errorResponse, wrap } from '../../src/server/http.ts'
import { TuiError } from '../../src/tui/index.ts'
import { quiet } from './fake.ts'

test('wrap puts ok first and spreads the data', async () => {
  const res = await wrap(async () => ({ pane: 'w1:p1' }))
  expect(await res.text()).toBe('{"ok":true,"pane":"w1:p1"}')
})

test('errors map to status and code', async () => {
  const cases: [unknown, number, string][] = [
    [new UserError('no_agent', 'No agent', 404), 404, 'no_agent'],
    [new TuiError('stale_dialog', 'This dialog changed since it was shown'), 400, 'stale_dialog'],
    [new HerdrError('herdr pane read: timed out'), 502, 'herdr'],
    [new TypeError('boom'), 500, 'internal'],
  ]
  for (const [err, status, code] of cases) {
    const res = await quiet(async () => errorResponse(err))
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ ok: false, code })
  }
})
