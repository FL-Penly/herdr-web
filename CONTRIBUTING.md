# Contributing

Thanks for helping. herdr-web is small on purpose, and these notes keep it that way.

## Setup

You need [Bun](https://bun.sh) 1.3.7+, and for trying things by hand, [herdr](https://herdr.dev) 0.9.5+ with
Claude Code or Codex.

```sh
bun install
bun run dev      # the server, restarted on change; open the URL it prints
bun run check    # typecheck + lint + tests, the same as CI
```

Other scripts: `bun test`, `bun run typecheck`, `bun run lint`, and `bun run format` (Biome, writes fixes).

## Where things live

[docs/architecture.md](docs/architecture.md) explains the moving parts. In short: `src/agents` reads
Claude Code's and Codex's files, `src/tui` reads and drives their screens, `src/inbox` decides what needs you,
`src/server` and `src/actions` are the HTTP side, and `public/js` is the browser app (no build step).
`plugin/quick-fork/fork.ts` must stay self-contained: node and bun builtins only.

## Conventions

- TypeScript in strict mode, formatted by Biome: 2 spaces, single quotes, no semicolons, 120 columns.
- Small modules with one job, and pure functions where possible.
- Module-level caches are fine as long as they stay bounded: `TtlCache` (`src/lib/cache.ts`) for entries that
  expire, `readCached` / `readJsonCached` (`src/lib/fs.ts`) for files keyed by their mtime.
- In `src/`, `src/config.ts` is the only module that reads `process.env`. A new setting goes there and in the
  README's configuration table, in both languages.
- No module does work when it is imported. Clients, drivers and queues are built in `src/main.ts` and passed
  in, so tests hand the same code fakes. Tests run hermetically: `test/setup.ts` (preloaded by `bunfig.toml`)
  points every home and config dir at a temp dir.
- `src/protocol.ts` is the contract between server and browser. Change both sides together. Browser modules
  that start with `// @ts-check` are type-checked against it by `bun run typecheck`; new ones should too.
- Code, comments, server errors and docs are in English. Every string the UI shows goes through `t()`, with an
  entry in both `public/js/i18n/en.js` and `public/js/i18n/zh-CN.js`.
- Comments explain *why* (a TUI quirk, a file-format fact, a security reason), not what the next line does.

## When Claude Code or Codex change their TUI

Most breakage comes from here: a dialog, a status line or a menu that renders differently in a new version.
A fix in `src/tui` comes with a regression test:

1. Capture the screen while it shows the problem:
   `herdr pane read <pane> --source visible --lines 60 > test/fixtures/screens/<agent>-<what>.txt`.
2. Scrub it: no real prompts, names, paths (use `/home/alice/project`) or ids (use fake uuids).
3. Add a test next to the parser's other tests in `test/tui/` that loads it with `screen('<agent>-<what>')` and
   checks the parsed result, then fix the parser.

The regexes match the English *and* the Chinese strings the TUIs print. Keep both alternatives when you edit
one. The same goes for transcript and rollout formats: add a small synthetic JSONL under
`test/fixtures/claude/` or `test/fixtures/codex/` that shows the new shape.

## Pull requests

- One topic per PR. Explain what changed and why, and how you tried it (agent, version, browser, desktop or
  phone).
- `bun run check` must pass.
- Note user-visible changes in `CHANGELOG.md` under "Unreleased".
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) in English:
  `fix(tui): read the effort from the new status line`.

## Reporting bugs

Use the bug report form, and include versions and a screen dump. For security issues, see
[SECURITY.md](SECURITY.md).
