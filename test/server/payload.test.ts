import { expect, test } from 'bun:test'
import { toStatePayload } from '../../src/server/payload.ts'
import { fakeSnapshot, fakeView } from './fake.ts'

const views = [fakeView('w1:p1', 'w1', 'working'), fakeView('w2:p1', 'w2', 'blocked')]
const opts = { hidden: new Set<string>(), home: '/home/alice', version: '0.1.0+x' }

test('projects tabs, terminals and workspaces', () => {
  const p = toStatePayload(fakeSnapshot(), views, opts)
  expect(p.type).toBe('state')
  expect(p.home).toBe('/home/alice')
  expect(p.version).toBe('0.1.0+x')
  expect(p.tabs).toEqual([
    { id: 'w1:t1', workspace: 'w1', label: 'main', number: 1, panes: ['w1:p1', 'w1:p2'] },
    { id: 'w2:t1', workspace: 'w2', label: 'board', number: 1, panes: ['w2:p1', 'w2:p2'] },
  ])
  expect(p.terminals.map(t => t.pane)).toEqual(['w1:p2', 'w2:p2'])
  expect(p.terminals[0]).toEqual({
    pane: 'w1:p2',
    workspace: 'w1',
    tab: 'w1:t1',
    cwd: '/home/alice/project',
    title: 'build',
  })
  expect(p.workspaces[0]).toEqual({
    id: 'w1',
    label: 'app',
    number: 1,
    cwd: '/home/alice/project/sub',
    busy: true,
    agents: 1,
  })
  expect(p.workspaces[1]?.busy).toBe(true)
})

test('hidden workspaces leave the sidebar but their agents still reach the inbox', () => {
  const p = toStatePayload(fakeSnapshot(), views, { ...opts, hidden: new Set(['Board']) })
  expect(p.workspaces.map(w => w.id)).toEqual(['w1'])
  expect(p.tabs.map(t => t.id)).toEqual(['w1:t1'])
  expect(p.terminals.map(t => t.pane)).toEqual(['w1:p2'])
  expect(p.agents.map(a => a.pane)).toEqual(['w1:p1', 'w2:p1'])
})

test('matches labels exactly', () => {
  const p = toStatePayload(fakeSnapshot(), views, { ...opts, hidden: new Set(['board', 'Boar']) })
  expect(p.workspaces).toHaveLength(2)
})
