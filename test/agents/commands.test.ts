import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_BUILTINS, claudeCommands } from '../../src/agents/claude/commands.ts'
import { CODEX_BUILTINS, codexCommands, codexSkills } from '../../src/agents/codex/commands.ts'
import { dedupe, firstLine, markdownCommands, skillsIn } from '../../src/agents/commands.ts'
import { slashCommands } from '../../src/agents/index.ts'

const root = mkdtempSync(join(tmpdir(), 'commands-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

describe('command scanning', () => {
  test('nested command dirs are namespaced with ":"; description falls back to the first heading', () => {
    const dir = join(root, 'a', 'commands')
    put(join(dir, 'deploy.md'), '---\r\ndescription: Deploy it\r\n---\r\nbody')
    put(join(dir, 'git', 'commit.md'), '# Commit the changes\n\nMore')
    put(join(dir, 'notes.txt'), 'ignored')
    expect(markdownCommands(dir, 'user')).toEqual([
      { name: 'deploy', desc: 'Deploy it', type: 'command', origin: 'user' },
      { name: 'git:commit', desc: 'Commit the changes', type: 'command', origin: 'user' },
    ])
  })

  test('skills: frontmatter name, folded description, user-invocable: false hidden', () => {
    const dir = join(root, 'b', 'skills')
    put(join(dir, 'one', 'SKILL.md'), '---\nname: first-skill\ndescription: >\n  Does the\n  first thing\n---\n')
    put(join(dir, 'two', 'SKILL.md'), '---\ndescription: hidden\nuser-invocable: false\n---\n')
    put(join(dir, 'three', 'README.md'), 'no SKILL.md')
    expect(skillsIn(dir, 'project', 'plug:')).toEqual([
      { name: 'plug:first-skill', desc: 'Does the first thing', type: 'skill', origin: 'project' },
    ])
  })

  test('dedupe keeps the first of each name; firstLine strips heading marks', () => {
    const c = (name: string, desc: string) => ({ name, desc, type: 'command' as const, origin: 'user' as const })
    expect(dedupe([c('x', '1'), c('y', '2'), c('x', '3')]).map(x => x.desc)).toEqual(['1', '2'])
    expect(firstLine('\n\n## Title here\nrest')).toBe('Title here')
  })
})

describe('agent command lists', () => {
  test('Claude: builtins first (English), then project commands and skills', () => {
    const cwd = join(root, 'proj')
    put(join(cwd, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship it\n---\n')
    put(join(cwd, '.claude', 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint\n---\n')
    put(join(cwd, '.claude', 'commands', 'clear.md'), '---\ndescription: shadowed by the builtin\n---\n')
    const list = claudeCommands(cwd)
    expect(
      list.slice(0, CLAUDE_BUILTINS.length).every(c => c.type === 'builtin' && /^[\x20-\x7e]+$/.test(c.desc)),
    ).toBe(true)
    expect(list.find(c => c.name === 'ship')).toEqual({
      name: 'ship',
      desc: 'Ship it',
      type: 'command',
      origin: 'project',
    })
    expect(list.find(c => c.name === 'lint')).toEqual({ name: 'lint', desc: 'Lint', type: 'skill', origin: 'project' })
    expect(list.filter(c => c.name === 'clear')).toHaveLength(1)
  })

  test('Codex: builtins, and project skills next to the user ones', () => {
    expect(
      codexCommands()
        .slice(0, CODEX_BUILTINS.length)
        .map(c => c.name),
    ).toEqual(CODEX_BUILTINS.map(([n]) => n))
    const cwd = join(root, 'cproj')
    put(join(cwd, '.agents', 'skills', 'proj-skill-xyz', 'SKILL.md'), '---\ndescription: Project skill\n---\n')
    expect(codexSkills(cwd).find(s => s.name === 'proj-skill-xyz')).toEqual({
      name: 'proj-skill-xyz',
      desc: 'Project skill',
      type: 'skill',
      origin: 'project',
    })
  })

  test('slashCommands: skills only for Codex', () => {
    expect(slashCommands('claude', '').skills).toEqual([])
    expect(slashCommands('codex', '').commands[0]?.name).toBe('goal')
  })
})
