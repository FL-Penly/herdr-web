// @ts-check

/** @param {number} ms */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * Compact on purpose (`5m`, `3h`, `2d`): it sits next to truncated titles in the sidebar.
 * @param {number} ts
 * @param {{ now?: number; justNow?: string }} [options]
 */
export function relativeTime(ts, { now = Date.now(), justNow = 'now' } = {}) {
  const s = Math.max(0, (now - ts) / 1000)
  if (s < 60) return justNow
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/**
 * @param {number} n
 * @param {string} [locale]
 */
export function compactNumber(n, locale = 'en') {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

/**
 * @param {string | null | undefined} cwd
 * @param {string} home
 */
export function shortCwd(cwd, home) {
  const path = String(cwd ?? '')
  if (!home || home === '/') return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * The shell's title is usually `user@host: /path`; show just the (shortened) path.
 * @param {{ title?: string; cwd?: string } | null | undefined} terminal
 * @param {string} home
 */
export function terminalTitle(terminal, home) {
  const title = (terminal?.title ?? '').replace(/^[\w.-]+@[\w.-]+:\s*/, '')
  return shortCwd(title, home) || shortCwd(terminal?.cwd, home)
}

/**
 * `claude-opus-5-5[1m]` → `Opus 5.5 (1M)`, `gpt-5.1-codex` → `GPT-5.1-codex`.
 * @param {string} id
 */
export function prettyModel(id) {
  return String(id ?? '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}(?=$|\[)/, '')
    .replace(
      /-(\d+)-(\d+)(\[(\w+)\])?$/,
      (_, major, minor, _suffix, ctx) => ` ${major}.${minor}${ctx ? ` (${ctx.toUpperCase()})` : ''}`,
    )
    .replace(/^(opus|sonnet|haiku|fable)/, s => s[0].toUpperCase() + s.slice(1))
    .replace(/^gpt-/, 'GPT-')
}

/**
 * Cuts the status at its first parenthesis: `Thinking… (12s · esc to interrupt)` → `Thinking…`.
 * @param {string | null | undefined} activity
 */
export const activityLabel = activity => (activity ?? '').replace(/\s*[(（].*$/, '')

/**
 * Upload names: keep real file names, give pasted screenshots (all called `image.png`) a unique one.
 * @param {{ name?: string; type?: string }} file
 * @param {number} [now]
 */
export function uploadName(file, now = Date.now()) {
  if (file.name && file.name !== 'image.png') return file.name
  const ext = ((file.type ?? '').split('/')[1] || 'png').replace('jpeg', 'jpg')
  return `paste-${now}.${ext}`
}

// herdr-web stores uploads as `<uploadDir>/<yyyymmddhhmmss>-<6 hex>-<name>`, under a `herdr-web/uploads` dir.
const UPLOAD_PATH_RE = /(?<!\S)\/\S*\/herdr-web\/uploads\/(\d{14}-[0-9a-f]{6}-)?(\S+)/g
const IMAGE_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg)$/i

/**
 * A message split into its text and the files uploaded through herdr-web that it carries as paths.
 * @param {string} text
 * @returns {{ text: string; files: { path: string; name: string; image: boolean }[] }}
 */
export function uploadParts(text) {
  /** @type {{ path: string; name: string; image: boolean }[]} */
  const files = []
  const rest = String(text ?? '').replace(UPLOAD_PATH_RE, (path, _stamp, name) => {
    files.push({ path, name, image: IMAGE_RE.test(name) })
    return ''
  })
  return {
    text: files.length
      ? rest
          .replace(/[ \t]+$/gm, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      : rest,
    files,
  }
}

// `[图片1]`, `[附件2]` (`[Image 1]`, `[File 2]` in English): where the user put an attachment in the message.
const TOKEN = String.raw`\[(?:图片|附件|Image |File )\d+\]`
export const ATTACHMENT_TOKEN_RE = new RegExp(TOKEN, 'g')
const IMAGE_TOKEN_RE = /^\[(?:图片|Image )\d+\]$/
// A token and what came after it in the pane: the file's path, or `[Image #n]` once Claude Code took the image.
const TOKEN_PAIR_RE = new RegExp(
  String.raw`(${TOKEN})[ \t]*(?:(\/\S*\/herdr-web\/uploads\/(?:\d{14}-[0-9a-f]{6}-)?\S+)|\[Image #\d+\])`,
  'g',
)

/**
 * The message as it goes to the agent: each attachment's path right after its token, where the user put it, so
 * the model knows which file the words around it mean. One whose token is gone from the text goes at the end.
 * @param {string} text
 * @param {{ token: string; path: string }[]} items
 */
export function embedAttachments(text, items) {
  let out = text.trim()
  const rest = []
  for (const { token, path } of items) {
    const at = token ? out.indexOf(token) : -1
    if (at < 0) {
      rest.push(token ? `${token} ${path}` : path)
      continue
    }
    const after = out.slice(at + token.length)
    out = `${out.slice(0, at)}${token} ${path}${after && !/^\s/.test(after) ? ' ' : ''}${after}`
  }
  return [out, ...rest].filter(Boolean).join('\n')
}

/**
 * A sent message's attachments by their token, each pair replaced by a marker `\u0001<index>\u0001`. Claude Code
 * keeps only `[Image #n]` for an image: its path is the next of `sentImages` (this tab's, in order), if known.
 * @param {string} text
 * @param {string[]} [sentImages]
 * @returns {{ text: string; chips: { label: string; path: string | null; image: boolean }[]; images: number }}
 */
export function attachmentChips(text, sentImages = []) {
  /** @type {{ label: string; path: string | null; image: boolean }[]} */
  const chips = []
  let images = 0
  let marked = String(text ?? '').replace(TOKEN_PAIR_RE, (_, token, path) => {
    const label = token.slice(1, -1)
    if (path) chips.push({ label, path, image: IMAGE_RE.test(path) })
    else chips.push({ label, path: sentImages[images++] ?? null, image: true })
    return `\u0001${chips.length - 1}\u0001`
  })
  // Claude Code may move an image's `[Image #n]` away from its token (a message sent while it worked starts with
  // them): picture tokens left alone take the markers left over, in order.
  const loose = marked.match(/\[Image #\d+\]/g)?.length ?? 0
  let taken = 0
  marked = marked.replace(ATTACHMENT_TOKEN_RE, token => {
    if (taken >= loose || !IMAGE_TOKEN_RE.test(token)) return token
    taken++
    chips.push({ label: token.slice(1, -1), path: sentImages[images++] ?? null, image: true })
    return `\u0001${chips.length - 1}\u0001`
  })
  let dropped = 0
  if (taken) marked = marked.replace(/\[Image #\d+\][ \t]*/g, m => (dropped++ < taken ? '' : m))
  return { text: marked, chips, images }
}

/**
 * What a sent message and its transcript copy have in common once Claude Code has turned its image paths into
 * `[Image #n]` markers: the text without markers, upload paths or spacing.
 * @param {string} text
 */
export const sentMessageKey = text =>
  uploadParts(String(text ?? '').replace(/\[Image #\d+\]/g, ' ')).text.replace(/\s+/g, '')

/** @param {string} path */
export const uploadDisplayName = path => uploadParts(path).files[0]?.name ?? path.split('/').pop() ?? path

/**
 * Table cells that must not wrap on a narrow screen: numbers, and short single words such as ids or flags.
 * @param {string} text
 */
export function isCompactCell(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  if (/^[-+]?[\d.,:%/]+$/.test(s)) return s.length <= 16
  return s.length <= 12 && !/\s/.test(s)
}

const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u

/**
 * A table column of sentences: given only its minimum width, a narrow table squeezes it to a word per line
 * while its neighbours stay wide, so it is given a reading width and the table scrolls instead.
 * @param {string[]} cells the column's cells, header included
 */
export function isProseColumn(cells) {
  const width = (/** @type {string} */ s) => [...s.trim()].reduce((n, ch) => n + (WIDE_CHAR.test(ch) ? 2 : 1), 0)
  // Sentences: spaced words, or CJK text (which has no spaces); a long id without either stays as is.
  return cells.some(c => (/\s/.test(c.trim()) || WIDE_CHAR.test(c)) && width(c) >= 28)
}

/**
 * What every completion starts with, for Tab in a path field (`~/pro` + [`~/projects/a`, `~/projects/b`]
 * → `~/projects/`).
 * @param {string[]} items
 */
export function commonPrefix(items) {
  if (!items.length) return ''
  let prefix = items[0]
  for (const item of items.slice(1)) {
    let i = 0
    while (i < prefix.length && prefix[i] === item[i]) i++
    prefix = prefix.slice(0, i)
  }
  return prefix
}

/**
 * A long path cut in the middle, keeping its start and the folders nearest the end:
 * `/data00/home/me/project/open_source/herdr-web` → `/data00/…/open_source/herdr-web`.
 * @param {string} path
 * @param {number} [max]
 */
export function elidePath(path, max = 44) {
  if (path.length <= max) return path
  const parts = path.split('/')
  const head = parts[0] === '' ? `/${parts[1]}` : parts[0]
  let tail = parts.at(-1) ?? ''
  for (let i = parts.length - 2; i > 1; i--) {
    const next = `${parts[i]}/${tail}`
    if (head.length + next.length + 2 > max) break
    tail = next
  }
  return `${head}/…/${tail}`
}
