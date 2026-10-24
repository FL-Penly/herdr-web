#!/usr/bin/env bun
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Server, ServerWebSocket, WebSocketServeOptions } from 'bun'
import { forkSession } from '../plugin/quick-fork/fork.ts'
import { conversationOf } from './actions/context.ts'
import { type ActionContext, dispatch } from './actions/index.ts'
import { sendQueued } from './actions/reply.ts'
import { codexSessionId, isCodexRollout, lastTurn, locateTranscript, pinCodexSession } from './agents/index.ts'
import { config } from './config.ts'
import { type Agent, herdr } from './herdr.ts'
import { InboxService } from './inbox/index.ts'
import { TtlCache } from './lib/cache.ts'
import { readJson } from './lib/fs.ts'
import { KeyedMutex } from './lib/mutex.ts'
import { isLoopback, loginUrl, readToken, resolveToken, tokenFile } from './server/auth.ts'
import { RecentDirs, isDir } from './server/dirs.ts'
import { FirstMessageQueue } from './server/first-message.ts'
import { STATE_TOPIC, StateHub } from './server/hub.ts'
import { createQueries } from './server/queries.ts'
import { ReplyQueues } from './server/reply-queue.ts'
import { type ServerDeps, type WSData, createFallback, createRoutes } from './server/routes.ts'
import { createStatic } from './server/static.ts'
import { type TermData, TerminalBridge } from './server/terminal.ts'
import { MAX_UPLOAD_BYTES, ensurePrivateDir, pruneUploads } from './server/upload.ts'
import { createUsage, readKeychain } from './server/usage.ts'
import { createDriver, isReadyForInput } from './tui/index.ts'

const ROOT = join(import.meta.dir, '..')
const SHUTDOWN_GRACE_MS = 300
// Older Bun sends a WebSocket handshake's subprotocol header twice, and browsers drop such a connection.
const MIN_BUN = '1.3.7'

function publicBase(): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? hostname() : config.host
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}/`
}

function fatal(err: unknown): never {
  console.error(`herdr-web: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}

function startupMessage(token: string | null): string {
  const lines = [`herdr-web listening on ${publicBase()}`]
  if (token === null)
    lines.push('  auth is OFF (HERDR_WEB_TOKEN=off): anyone who can reach this port controls your panes')
  // stdout under systemd goes to the journal; keep the token out of it.
  else if (process.stdout.isTTY) lines.push(`  open ${loginUrl(publicBase(), token)}`)
  else
    lines.push(
      `  token: ${config.token ? 'HERDR_WEB_TOKEN' : tokenFile(config.configDir)} (print the login link: bun run url)`,
    )
  if (!isLoopback(config.host))
    lines.push(`  warning: plain HTTP on ${config.host}; prefer an SSH tunnel, Tailscale or a TLS reverse proxy`)
  return lines.join('\n')
}

/** `--print-url`: read-only, so it never creates the token file a running server has not written yet. */
function printUrl(): void {
  let token: string | null | undefined
  try {
    token = readToken({ env: config.token, configDir: config.configDir, host: config.host })
  } catch (err) {
    fatal(err)
  }
  if (token === undefined) fatal('no token yet: start herdr-web first')
  console.log(loginUrl(publicBase(), token))
}

function main(): void {
  if (process.argv.includes('--print-url')) {
    printUrl()
    return
  }
  if (Bun.semver.order(Bun.version, MIN_BUN) < 0)
    fatal(`Bun ${MIN_BUN} or newer is needed (this is ${Bun.version}); upgrade with \`bun upgrade\``)
  let token: string | null
  try {
    token = resolveToken({ env: config.token, configDir: config.configDir, host: config.host })
  } catch (err) {
    fatal(err)
  }

  try {
    ensurePrivateDir(config.uploadDir)
    pruneUploads(config.uploadDir)
  } catch (err) {
    fatal(err)
  }

  const version = `${readJson<{ version?: string }>(join(ROOT, 'package.json'))?.version ?? '0.0.0'}+${Date.now().toString(36)}`
  const inbox = new InboxService()
  const locks = new KeyedMutex()
  const firstMessages = new FirstMessageQueue({
    readScreen: pane => herdr.readScreen(pane),
    prompt: (pane, text) => herdr.prompt(pane, text),
    isReady: isReadyForInput,
    locks,
  })
  const replyQueues = new ReplyQueues({
    readScreen: pane => herdr.readScreen(pane),
    isReady: isReadyForInput,
    send: (pane, text, wanted) => sendQueued(ctx, pane, text, wanted),
    conversation: async (pane): Promise<string | null> => {
      const agent: Agent | null = hub.agent(pane)
      return agent ? conversationOf(ctx, agent) : null
    },
    busy: pane => locks.busy(pane),
    path: join(config.configDir, 'queue.json'),
  })
  let server: Server | null = null
  const hub = new StateHub({
    snapshot: herdr.snapshot,
    inbox,
    firstMessages,
    replyQueues,
    publish: payload => server?.publish(STATE_TOPIC, payload),
    payload: { hidden: config.hiddenWorkspaces, home: config.home, version },
    intervalMs: config.tickMs,
  })
  const terminals = new TerminalBridge(
    args => Bun.spawn([config.herdrBin, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }),
    pane => inbox.input(pane),
  )
  const recentDirs = new RecentDirs(join(config.configDir, 'dirs.json'))
  const ctx: ActionContext = {
    hub,
    herdr,
    inbox,
    tui: createDriver({
      readScreen: pane => herdr.readScreen(pane),
      readStyled: pane => herdr.readStyled(pane),
      sendKeys: herdr.sendKeys,
      sendText: herdr.sendText,
      sleep: Bun.sleep,
    }),
    firstMessages,
    replyQueues,
    locks,
    agents: { locateTranscript, codexSessionId, isCodexRollout, lastTurn, pinCodexSession },
    fork: o =>
      forkSession({ ...o, herdrBin: config.herdrBin, claudeDirs: config.claudeDirs, codexHome: config.codexHome }),
    requests: new TtlCache<string, object>(30_000, 200),
    dirs: { isDir, record: dir => recentDirs.record(dir) },
    home: config.home,
  }
  const deps: ServerDeps = {
    token,
    statics: createStatic({ publicDir: join(ROOT, 'public'), nodeModules: join(ROOT, 'node_modules') }),
    queries: createQueries(hub, {
      home: config.home,
      recentDirs: () => recentDirs.list(),
      hidden: config.hiddenWorkspaces,
    }),
    act: body => dispatch(ctx, body),
    uploadDir: config.uploadDir,
    usage: createUsage({
      home: config.home,
      claudeHome: config.claudeHome,
      codexHome: config.codexHome,
      platform: process.platform,
      fetch: (url, init) => fetch(url, init),
      keychain: readKeychain,
      now: Date.now,
    }),
  }

  const isTerm = (ws: ServerWebSocket<WSData>): ws is ServerWebSocket<TermData> => ws.data.kind === 'term'
  // bun-types 1.2 does not model `routes` next to `websocket` yet (the runtime has supported it since 1.2.3).
  const options: WebSocketServeOptions<WSData> & { routes: ReturnType<typeof createRoutes>; idleTimeout: number } = {
    hostname: config.host,
    port: config.port,
    // Actions such as fork can take a while; herdr calls carry their own timeouts.
    idleTimeout: 0,
    maxRequestBodySize: MAX_UPLOAD_BYTES + (1 << 20),
    routes: createRoutes(deps),
    fetch: createFallback(deps),
    websocket: {
      idleTimeout: 0,
      open(ws) {
        if (isTerm(ws)) return terminals.open(ws)
        ws.subscribe(STATE_TOPIC)
        if (hub.payload) ws.send(hub.payload)
      },
      message(ws, msg) {
        if (isTerm(ws)) terminals.message(ws, msg)
      },
      drain(ws) {
        if (isTerm(ws)) terminals.drain(ws)
      },
      close(ws) {
        if (isTerm(ws)) terminals.close(ws)
      },
    },
  }
  server = Bun.serve(options)
  void hub.start()
  console.log(startupMessage(token))

  const shutdown = () => {
    hub.stop()
    terminals.closeAll()
    // Give the terminal sessions their `terminal.release` before the herdr children are killed.
    setTimeout(() => {
      server?.stop(true)
      process.exit(0)
    }, SHUTDOWN_GRACE_MS)
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

main()
