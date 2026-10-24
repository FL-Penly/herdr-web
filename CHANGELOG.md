# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-24

The first public release.

### Added

- A web UI for the Claude Code and Codex sessions running in herdr: a sidebar of every agent pane across
  workspaces, with live status, activity, git branch and context use, and a Claude Code or Codex icon.
- An inbox for what needs you (permission prompts, questions, dialogs, finished turns), with a count in the tab
  title, toasts, an optional sound, desktop notifications, "mark handled" and snooze.
- Threads read from Claude Code transcripts and Codex rollouts: Markdown replies, tool runs folded the way the
  TUIs fold them, diffs for edits, todos, goals (`/goal`), plans in full, slash-command output, background
  shells, and the reply being written streamed from the screen. The prompt of the turn being read stays pinned
  on top.
- Answering from the browser: permission prompts with the whole proposed change, numbered and arrow-key
  dialogs, free-text options, `AskUserQuestion` with several questions (progress, and every answer before it is
  submitted), Codex's queued questions, `1`–`9` and `Esc`. A click is checked against the dialog on screen, so
  it never answers a prompt the browser did not show.
- A composer: messages added to a running turn, a queue sent one per turn once it ends (the same for both
  agents; edit, delete or send now), stop with the message given back, model, effort and mode switching
  (Shift+Tab or a tap), a `/` picker for commands and skills, and images and files pasted or dropped into the
  message as `[图片1]` capsules. Text typed in the terminal is never spliced into.
- A terminal for every pane through `herdr terminal session` and xterm.js, sized to the browser while in
  control, with clicks passed to the program, a touch key bar and input line, find, copy and *Quote in
  message*. A command that opens a panel switches to the terminal and back.
- A file viewer for paths an agent names: pictures, video, audio, PDFs, Markdown and code at the line named.
- A review panel for the working tree's diff, new files included, with comments sent back to the agent.
- New sessions from a folder, in the workspace already working there or a new one; workspace rename.
- Forking a session from its end or from any earlier reply into a new tab or split, and the quick-fork herdr
  plugin (`plugin/quick-fork`) that does it.
- Codex panes matched to their rollouts, `/new`, `/resume` and resumed segments included, with *Sync
  conversation…* to set a pane right by hand.
- Optional subscription usage (5-hour and weekly limits of the Claude Code and Codex sign-ins), *Keep screen
  on*, light and dark themes, a mobile layout and PWA, a command palette, and an English and Chinese UI.
- Configuration through `HERDR_WEB_*` environment variables, documented in the README.
- Security: a loopback-only default bind, an origin-scoped bearer token (never a cookie) given through the
  login link's fragment, Origin checks on WebSockets and state-changing requests, and a log of what is typed
  into panes. See SECURITY.md.
- A systemd user unit in `contrib/systemd`.

[Unreleased]: https://github.com/FL-Penly/herdr-web/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/FL-Penly/herdr-web/releases/tag/v0.1.0
