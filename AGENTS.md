# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the Bun/TypeScript backend: `agents/` reads transcripts, `tui/` parses and drives terminal screens, `inbox/` tracks attention, and `server/` plus `actions/` handle HTTP and operations.
- `public/` holds HTML, CSS, icons, and browser ES modules in `public/js/`; there is no build step.
- `test/` mirrors backend modules; `test/web/` covers browser logic and `test/fixtures/` stores screen dumps and synthetic JSONL.
- `plugin/quick-fork/` contains the standalone fork plugin. Keep `fork.ts` self-contained, using only Node/Bun builtins.
- See `docs/architecture.md` for design details and `docs/assets/` for documentation images.

## Build, Test, and Development Commands

Use Bun 1.3.7+; manual integration testing also needs herdr 0.9.5+ and Claude Code or Codex.

- `bun install`: install dependencies.
- `bun run dev`: start the server with restart-on-change; open its printed URL.
- `bun start`: run the server normally.
- `bun run check`: run typechecking, Biome checks, and tests, matching CI.
- `bun test`: run the test suite; `bun test test/tui/dialog.test.ts` targets one file.
- `bun run typecheck`, `bun run lint`, `bun run format`: check types, check style, or apply Biome fixes.

## Coding Style & Naming Conventions

Use strict TypeScript and small, focused modules. Biome enforces two spaces, single quotes, semicolons only as needed, and 120-column lines. Follow existing kebab-case filenames, camelCase functions, and PascalCase types. Add `// @ts-check` to new browser modules.

Keep server/browser changes aligned with `src/protocol.ts`. Initialize dependencies in `src/main.ts`; avoid import-time work. Route UI strings through `t()` and update both `public/js/i18n/en.js` and `zh-CN.js`.

## Testing Guidelines

Use `bun:test` with `*.test.ts` filenames. Preserve isolation through the temporary directories configured by `test/setup.ts`. No numeric coverage threshold is configured. TUI parsing or key-sequence changes require sanitized screen fixtures and regression tests; preserve English and Chinese matching. Use synthetic JSONL for transcript changes.

## Commit & Pull Request Guidelines

Use English Conventional Commits, consistent with history: `fix(tui): handle updated permission dialog`. Keep PRs focused; explain what changed, why, and testing. Link relevant issues and record manual agent/version, browser, and device checks. Ensure `bun run check` passes and document user-visible changes under `CHANGELOG.md` → `Unreleased`.

## Configuration

Within `src/`, read environment variables only in `src/config.ts`. Document new settings in both README configuration tables.
