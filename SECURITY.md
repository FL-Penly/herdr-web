# Security

## What herdr-web can do

herdr-web is a remote control for your terminal. It can type into every pane herdr runs, approve an agent's
permission prompts, start new shells and agents, and read your Claude Code and Codex transcripts and git
diffs. Anyone who gets through its authentication can run commands as the user herdr-web runs as.

The defaults are built around that:

- It listens on `127.0.0.1` only. Binding another interface takes an explicit `HERDR_WEB_HOST`.
- Every API request and WebSocket needs the access token: a random token generated once into
  `~/.config/herdr-web/token` (mode `0600`). An empty or short token file is replaced, never read as "no auth".
  `HERDR_WEB_TOKEN=off` is refused unless the host is loopback. Only the app shell and its static assets (HTML,
  scripts, styles, icons, the manifest and the service worker) are served without it; they hold no secrets.
- The token is origin-scoped, never ambient. The browser keeps it in `localStorage` for herdr-web's origin
  (scheme, host and port) and sends it as `Authorization: Bearer …`, or for a WebSocket as the subprotocol
  `bearer.<token>` (the server answers with `herdr-web` and never echoes the token). herdr-web sets no
  cookies and ignores any cookie or query-string token. This matters on a shared host: cookies are scoped to
  a host name but not to a port, so a cookie would also be sent to any other service, or another local user's
  listener, on a different port of the same host.
- The login link carries the token in the URL fragment (`#t=…`), which browsers do not send to the server or
  a proxy; the page drops it from the address bar once signed in. The token is compared in constant time.
- WebSocket upgrades and non-GET requests must also come from the page's own origin, and `/api/act` only
  accepts `application/json`, so another site (even one on the same host) cannot drive your panes.
- The token is printed only to an interactive terminal, not to logs. `bun run url` prints the login URL on demand,
  reading the token without ever creating one.
- Pane, tab and key arguments are checked against herdr's current state before they reach the herdr CLI.
- Uploads go to a private `0700` directory and are capped at 25 MB. Those older than a week are deleted at
  startup and, at most hourly, when another file is uploaded.
- Browser libraries are served from `node_modules`, not a CDN, under a Content Security Policy.
- The quick-fork plugin passes the original session's API keys to the fork through a `0600` file that the new
  shell sources and deletes, so they never appear on screen or in a process list.

## What is out of scope

- Anyone who can already run code as your user, or read your home directory, can read the token too.
- Script running in herdr-web's own origin can read the stored token: an XSS in herdr-web would expose it. The
  Content Security Policy (`script-src 'self'`, no inline scripts) and sanitized Markdown are the defense.
  Pages on other origins, including other ports of the same host, cannot read it.
- Someone who uses your browser profile while you are signed in. *Sign out* in the settings forgets the token.
- Plain HTTP on a network you do not trust. Use an SSH tunnel, a private network or a TLS reverse proxy (see
  the README).
- What the agents themselves do once you approve it.

## Reporting a vulnerability

Please report it privately through
[GitHub Security Advisories](https://github.com/FL-Penly/herdr-web/security/advisories/new), not in a public
issue. Include the version or commit, how to reproduce it, and what an attacker gains.

You should get an answer within a week. Once a fix is released, the advisory is published with credit to you
unless you prefer otherwise.

Only the latest release and `main` get security fixes.
