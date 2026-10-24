# Quick fork

A [herdr](https://herdr.dev) plugin that forks the Claude Code or Codex session in the focused pane into a
new split or tab, so you can try another direction without losing the one you are on.

| Agent | What runs in the new pane |
| --- | --- |
| Claude Code | `claude <same flags> --resume <new id> -n "<title> · fork"`, on a copy of the transcript |
| Codex | `codex fork <id>` |

The fork:

- starts in the folder the session was recorded in, not wherever the pane has since `cd`'d to;
- for Claude Code, resumes a copy of the transcript under a new session id, so the new pane shows the whole
  history at once (`--fork-session` would write nothing until the first new message);
- for Claude Code, keeps the flags that shape the session (`--model`, `--effort`, `--permission-mode`,
  `--dangerously-skip-permissions`, `--add-dir …`, `--mcp-config …`, `--settings`, `--plugin-dir`,
  `--append-system-prompt`, `--agent`, …); Codex's flags (`-m`, `-c`, sandbox, approvals) are not carried over;
- inherits the original process's `CLAUDE_*` / `ANTHROPIC_*` (Claude) or `CODEX_*` / `OPENAI_*` (Codex)
  environment, through a `0600` file that the new shell sources and deletes, so tokens never show on screen.

## Install

```sh
herdr plugin install FL-Penly/herdr-web/plugin/quick-fork
# or, from a clone of herdr-web:
herdr plugin link "$PWD/plugin/quick-fork"
```

Requires [Bun](https://bun.sh) on the `PATH` herdr runs plugins with. It has no other dependencies.

## Actions

| Action | Does |
| --- | --- |
| `right` | Fork into a split on the right |
| `down` | Fork into a split below |
| `tab` | Fork into a new tab in the same workspace |

Bind them in herdr's keymap, or run one from the command line:

```sh
herdr plugin action invoke right --plugin quick-fork
bun fork.ts right|down|tab [pane] [--session ID] [--at MARK]
```

`--at` forks from an earlier reply instead of the end: a Claude message uuid, or `<rollout path>#<byte offset>`
for Codex. The transcript is copied up to that point under a new session id and the copy is resumed.
[herdr-web](../../README.md) uses this for its "fork from here" menu on every reply.

On failure the action shows a herdr notification; `herdr plugin log list` has the details.

## Platforms

- **Linux**: everything.
- **macOS**: works, but without environment inheritance (there is no `/proc/<pid>/environ`); the fork runs
  with the new shell's environment.

The command line is built for a POSIX shell (`sh`, `bash`, `zsh`). In fish or nushell panes, run the fork in a
pane whose shell is POSIX.
