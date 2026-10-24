import { describe, expect, test } from 'bun:test'
import { parseMenu } from '../../src/tui/menu.ts'
import { screen } from './fixtures.ts'

describe('parseMenu', () => {
  test('Claude /model arrow menu', () => {
    expect(parseMenu(screen('claude-model-menu'))).toMatchObject({
      kind: 'menu',
      options: [{ key: 'nav:-1' }, { key: 'nav:0' }, { key: 'nav:1' }],
    })
  })

  test('Codex numbered /model menu', () => {
    const m = parseMenu(screen('codex-model-menu'))
    expect(m).toMatchObject({
      kind: 'menu',
      question: 'Select Model and Effort\nSwitch the model for this and future Codex CLI sessions',
    })
  })

  test('Codex full-screen /resume picker: its list sits far above the key hints', () => {
    expect(parseMenu(screen('codex-resume-picker'))).toMatchObject({
      kind: 'menu',
      options: [
        { key: 'nav:0', label: '18s ago', desc: 'Draft the migration guide', current: true },
        { key: 'nav:1', label: '5m ago' },
      ],
    })
  })

  test('/status panel: the text below the rule, without the key hint', () => {
    expect(parseMenu(screen('claude-status-panel'))).toEqual({
      kind: 'panel',
      text: [
        '  Status   Config   Usage',
        '',
        '  Version: 2.1.0',
        '  Session ID: 00000000-0000-4000-8000-000000000001',
        '  cwd: /home/alice/project',
        '  Model: Opus 5.5 (1M context)',
      ].join('\n'),
    })
  })

  test('idle screens are not menus, even with hint-like transcript text', () => {
    expect(parseMenu(screen('claude-idle-spoof'))).toBeNull()
    expect(parseMenu(screen('codex-menu-spoof'))).toBeNull()
    expect(parseMenu(screen('codex-idle'))).toBeNull()
    expect(parseMenu(screen('claude-busy'))).toBeNull()
    expect(parseMenu('')).toBeNull()
  })
})
