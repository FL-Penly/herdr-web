import { describe, expect, test } from 'bun:test'
import {
  type TermData,
  type TermProcess,
  type TermSocket,
  TerminalBridge,
  clampSize,
  parseTermMessage,
} from '../../src/server/terminal.ts'

describe('clampSize', () => {
  test('clamps, truncates and falls back', () => {
    expect(clampSize('100', '30')).toEqual({ cols: 100, rows: 30 })
    expect(clampSize(99999, 1)).toEqual({ cols: 400, rows: 5 })
    expect(clampSize(80.7, 24.2)).toEqual({ cols: 80, rows: 24 })
    expect(clampSize(null, 'abc')).toEqual({ cols: 120, rows: 40 })
    expect(clampSize(undefined, Number.NaN, { cols: 90, rows: 20 })).toEqual({ cols: 90, rows: 20 })
    expect(clampSize(-5, Number.POSITIVE_INFINITY)).toEqual({ cols: 120, rows: 40 })
  })
})

describe('parseTermMessage', () => {
  test('accepts the browser protocol', () => {
    expect(parseTermMessage('{"type":"control","cols":80,"rows":24,"takeover":true}')).toEqual({
      type: 'control',
      cols: 80,
      rows: 24,
      takeover: true,
    })
    expect(parseTermMessage('{"type":"observe"}')).toEqual({ type: 'observe', cols: undefined, rows: undefined })
    expect(parseTermMessage('{"type":"input","data":"ls\\r"}')).toEqual({ type: 'input', data: 'ls\r' })
    expect(parseTermMessage('{"type":"scroll","direction":"down","lines":500}')).toEqual({
      type: 'scroll',
      direction: 'down',
      lines: 50,
    })
    expect(parseTermMessage('{"type":"scroll","direction":"sideways","lines":"x"}')).toEqual({
      type: 'scroll',
      direction: 'up',
      lines: 1,
    })
  })

  test('a click: action, button and the 0-based cell', () => {
    expect(parseTermMessage('{"type":"mouse","action":"down","button":"left","column":0,"row":12}')).toEqual({
      type: 'mouse',
      action: 'down',
      button: 'left',
      column: 0,
      row: 12,
    })
  })

  test('rejects garbage', () => {
    for (const raw of [
      'nope',
      'null',
      '[]',
      '{"type":"input","data":5}',
      '{"type":"resize","cols":"x"}',
      '{"type":"exec"}',
      '{"type":"mouse","action":"down","button":"left","column":-1,"row":0}',
      '{"type":"mouse","action":"down","button":"left","column":1.5,"row":0}',
      '{"type":"mouse","action":"wheel","button":"left","column":1,"row":0}',
      '{"type":"mouse","action":"down","button":"side","column":1,"row":0}',
    ])
      expect(parseTermMessage(raw)).toBeNull()
  })
})

function fakeProcess() {
  let push: (chunk: Uint8Array) => void = () => {}
  let end: () => void = () => {}
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      push = chunk => c.enqueue(chunk)
      end = () => c.close()
    },
  })
  const written: any[] = []
  const proc: TermProcess & { killed: boolean } = {
    stdin: { write: (s: string) => written.push(JSON.parse(s)), flush: () => {} },
    stdout,
    stderr: new ReadableStream({ start: c => c.close() }),
    killed: false,
    kill() {
      this.killed = true
    },
  }
  const line = (rec: object) => push(new TextEncoder().encode(`${JSON.stringify(rec)}\n`))
  return { proc, written, line, end }
}

function fakeSocket(pane = 'w1:p2') {
  const sent: any[] = []
  const binary: Uint8Array[] = []
  const ws = {
    data: { kind: 'term', pane, cols: 120, rows: 40, generation: 0 } as TermData,
    readyState: 1,
    buffered: 0,
    send: (m: string) => sent.push(JSON.parse(m)) && m.length,
    sendBinary: (b: Uint8Array) => binary.push(b) && b.length,
    getBufferedAmount() {
      return this.buffered
    },
  }
  return { ws: ws as unknown as TermSocket & { buffered: number }, sent, binary }
}

function setup() {
  const spawned: { args: string[]; fake: ReturnType<typeof fakeProcess> }[] = []
  const typedInto: string[] = []
  const bridge = new TerminalBridge(
    args => {
      const fake = fakeProcess()
      spawned.push({ args, fake })
      return fake.proc
    },
    pane => void typedInto.push(pane),
  )
  return { bridge, spawned, typedInto }
}

const frame = (text: string, extra: object = {}) => ({
  type: 'terminal.frame',
  bytes: Buffer.from(text).toString('base64'),
  width: 80,
  height: 24,
  ...extra,
})

describe('TerminalBridge', () => {
  test('observes on open and forwards frames as binary', async () => {
    const { bridge, spawned } = setup()
    const { ws, sent, binary } = fakeSocket()
    bridge.open(ws)
    expect(spawned[0]?.args).toEqual(['terminal', 'session', 'observe', 'w1:p2', '--cols', '120', '--rows', '40'])
    expect(sent[0]).toEqual({ type: 'mode', mode: 'observe' })
    const { line, end } = spawned[0]!.fake
    line(frame('hi', { full: true }))
    line(frame('there'))
    end()
    await Bun.sleep(5)
    expect(sent[1]).toEqual({ type: 'size', cols: 80, rows: 24, full: true })
    expect(binary.map(b => Buffer.from(b).toString())).toEqual(['hi', 'there'])
    expect(sent.at(-1)).toEqual({ type: 'ended', sawFrame: true })
  })

  test('a socket asked to open in control starts there, at the size it gave', () => {
    const { bridge, spawned } = setup()
    const { ws, sent } = fakeSocket()
    Object.assign(ws.data, { cols: 90, rows: 30, opening: 'control' })
    bridge.open(ws)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.args).toEqual(['terminal', 'session', 'control', 'w1:p2', '--cols', '90', '--rows', '30'])
    expect(sent[0]).toEqual({ type: 'mode', mode: 'control' })
  })

  test('control clamps sizes, releases the observer and only then accepts input', async () => {
    const { bridge, spawned, typedInto } = setup()
    const { ws } = fakeSocket()
    bridge.open(ws)
    bridge.message(ws, JSON.stringify({ type: 'input', data: 'ignored' }))
    expect(spawned[0]?.fake.written).toEqual([])
    bridge.message(ws, JSON.stringify({ type: 'control', cols: 9999, rows: 'x', takeover: true }))
    expect(spawned[0]?.fake.written).toEqual([{ type: 'terminal.release' }])
    expect(spawned[1]?.args).toEqual([
      'terminal',
      'session',
      'control',
      'w1:p2',
      '--cols',
      '400',
      '--rows',
      '40',
      '--takeover',
    ])
    expect(typedInto).toEqual([])
    bridge.message(ws, JSON.stringify({ type: 'input', data: 'ls' }))
    bridge.message(ws, JSON.stringify({ type: 'resize', cols: 1e9, rows: 10 }))
    // Keys typed here may answer the dialog on screen: the inbox starts a new episode for the next one.
    expect(typedInto).toEqual(['w1:p2'])
    expect(spawned[1]?.fake.written).toEqual([
      { type: 'terminal.input', bytes: Buffer.from('ls').toString('base64') },
      { type: 'terminal.resize', cols: 400, rows: 10 },
    ])
    bridge.close(ws)
    expect(spawned[1]?.fake.written.at(-1)).toEqual({ type: 'terminal.release' })
  })

  test('a click goes to herdr only in control, and counts as input on the press', () => {
    const { bridge, spawned, typedInto } = setup()
    const { ws } = fakeSocket()
    bridge.open(ws)
    const click = (action: string) =>
      bridge.message(ws, JSON.stringify({ type: 'mouse', action, button: 'left', column: 3, row: 2 }))
    click('down')
    expect(spawned[0]?.fake.written).toEqual([])
    bridge.message(ws, JSON.stringify({ type: 'control' }))
    click('down')
    click('up')
    expect(spawned[1]?.fake.written).toEqual([
      { type: 'terminal.mouse', action: 'down', button: 'left', column: 3, row: 2 },
      { type: 'terminal.mouse', action: 'up', button: 'left', column: 3, row: 2 },
    ])
    expect(typedInto).toEqual(['w1:p2'])
  })

  test('drops frames while the socket is backed up, then restarts for a full redraw', async () => {
    const { bridge, spawned } = setup()
    const { ws, binary } = fakeSocket()
    bridge.open(ws)
    const { line } = spawned[0]!.fake
    line(frame('a', { full: true }))
    await Bun.sleep(2)
    ws.buffered = 10 << 20
    line(frame('b'))
    line(frame('c'))
    await Bun.sleep(2)
    expect(binary).toHaveLength(1)
    expect(ws.data.stalled).toBe(true)
    bridge.drain(ws)
    expect(spawned).toHaveLength(1)
    ws.buffered = 0
    bridge.drain(ws)
    expect(spawned).toHaveLength(2)
    expect(spawned[1]?.args[2]).toBe('observe')
    expect(ws.data.stalled).toBe(false)
  })

  test('closeAll stops every session', () => {
    const { bridge, spawned } = setup()
    const a = fakeSocket('w1:p1')
    const b = fakeSocket('w1:p2')
    bridge.open(a.ws)
    bridge.open(b.ws)
    bridge.closeAll()
    expect(spawned.map(s => s.fake.written)).toEqual([[{ type: 'terminal.release' }], [{ type: 'terminal.release' }]])
  })
})
