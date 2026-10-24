import { resolve, sep } from 'node:path'

/** Browser libraries served from node_modules under /vendor/<package>/…; nothing else there is reachable. */
const VENDOR_PACKAGES = [
  '@xterm/xterm',
  '@xterm/addon-unicode11',
  '@xterm/addon-web-links',
  'marked',
  'dompurify',
  '@fontsource/inter',
  '@fontsource/jetbrains-mono',
] as const

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // The file viewer plays video and audio and shows PDFs from blobs it fetched (`/api/file` needs the token).
  "media-src 'self' blob:",
  'frame-src blob:',
  "connect-src 'self' ws: wss:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

interface StaticRoots {
  publicDir: string
  nodeModules: string
}

/**
 * Resolve a URL path under `root`, or null. Rejects encoded separators, dot segments, dotfiles and
 * anything that would leave the root after normalization.
 */
export function safeJoin(root: string, urlPath: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (rel.includes('\0') || rel.includes('\\')) return null
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length || parts.some(p => p.startsWith('.'))) return null
  const base = resolve(root)
  const full = resolve(base, ...parts)
  return full.startsWith(base + sep) ? full : null
}

function contentType(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return (ext && MIME[ext]) || null
}

async function sendFile(path: string | null, cacheControl: string): Promise<Response> {
  const type = path && contentType(path)
  const file = path && type ? Bun.file(path) : null
  if (!file || !type || !(await file.exists())) return notFound()
  // A BunFile body is sent with sendfile; the cast only papers over bun-types vs @types/node Blob typings.
  return new Response(file as unknown as Blob, {
    headers: { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': cacheControl },
  })
}

export function notFound(): Response {
  return new Response('not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

export function createStatic({ publicDir, nodeModules }: StaticRoots) {
  return {
    /** `/` and files under public/. Revalidated on every load: there is no build step to fingerprint names. */
    page(pathname: string): Promise<Response> {
      const rel = pathname === '/' ? 'index.html' : pathname
      return sendFile(safeJoin(publicDir, rel), 'no-cache')
    },
    /** `/vendor/<package>/<file>` for the allowlisted packages only. */
    vendor(pathname: string): Promise<Response> {
      const rest = pathname.replace(/^\/vendor\//, '')
      const pkg = VENDOR_PACKAGES.find(p => rest.startsWith(`${p}/`))
      if (!pkg) return Promise.resolve(notFound())
      const root = resolve(nodeModules, pkg)
      return sendFile(safeJoin(root, rest.slice(pkg.length + 1)), 'public, max-age=86400')
    },
  }
}

export type StaticFiles = ReturnType<typeof createStatic>
