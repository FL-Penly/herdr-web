import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/** One complete JSON line and its exact byte range in the file (`end` is just past the newline). */
export interface JsonlRow {
  row: unknown
  start: number
  end: number
}

export interface JsonlBatch {
  rows: JsonlRow[]
  /** The file was truncated or replaced since the last read: rows start over, drop any state built from it. */
  reset: boolean
}

export interface JsonlTailOptions {
  /** Never read past this byte offset (a fork base that ends mid-file). */
  limit?: number
  /** On the first read of a larger file, start this many bytes from the end (at the next line boundary). */
  maxInitialBytes?: number
}

const NEWLINE = 0x0a
// Only objects are rows; blank and garbage lines are skipped without decoding them.
const OPEN_BRACE = 0x7b

/**
 * Incremental reader for an append-only JSONL file. Offsets are byte-exact because lines are split on
 * raw bytes and only complete lines are decoded, so a read that lands inside a multibyte character
 * never corrupts text or shifts offsets. An unterminated last line is left for the next read.
 */
export class JsonlTail {
  /** Byte offset just past the last complete line consumed. */
  offset = 0
  /** The first read started `maxInitialBytes` from the end: the rows before that were never read. */
  skipped = false
  private ino: number | null = null
  private readonly limit: number
  private readonly maxInitialBytes: number

  constructor(
    readonly path: string,
    { limit = 0, maxInitialBytes = 30_000_000 }: JsonlTailOptions = {},
  ) {
    this.limit = limit
    this.maxInitialBytes = maxInitialBytes
  }

  read(): JsonlBatch {
    let fd: number
    try {
      fd = openSync(this.path, 'r')
    } catch {
      return { rows: [], reset: false }
    }
    try {
      return this.readFrom(fd)
    } finally {
      closeSync(fd)
    }
  }

  private readFrom(fd: number): JsonlBatch {
    const st = fstatSync(fd)
    let reset = false
    // A shrunken file, a new inode or a consumed line that no longer ends in '\n' means the file was rewritten.
    if (this.offset > 0 && (st.ino !== this.ino || st.size < this.offset || !endsLine(fd, this.offset))) {
      this.offset = 0
      this.skipped = false
      reset = true
    }
    this.ino = st.ino
    const size = this.limit ? Math.min(st.size, this.limit) : st.size
    if (size <= this.offset) return { rows: [], reset }

    let from = this.offset
    let skipFirstLine = false
    if (from === 0 && size > this.maxInitialBytes) {
      from = size - this.maxInitialBytes
      skipFirstLine = !endsLine(fd, from)
      this.skipped = true
    }
    const buf = Buffer.allocUnsafe(size - from)
    const n = readFully(fd, buf, from)
    const rows: JsonlRow[] = []
    let i = 0
    if (skipFirstLine) {
      const nl = buf.indexOf(NEWLINE)
      if (nl < 0 || nl >= n) return { rows, reset }
      i = nl + 1
      this.offset = from + i
    }
    for (;;) {
      const nl = buf.indexOf(NEWLINE, i)
      if (nl < 0 || nl >= n) break
      const start = from + i
      const end = from + nl + 1
      if (buf[i] === OPEN_BRACE) {
        try {
          rows.push({ row: JSON.parse(buf.toString('utf8', i, nl)), start, end })
        } catch {}
      }
      this.offset = end
      i = nl + 1
    }
    return { rows, reset }
  }
}

function endsLine(fd: number, offset: number): boolean {
  const b = Buffer.alloc(1)
  return readSync(fd, b, 0, 1, offset - 1) === 1 && b[0] === NEWLINE
}

function readFully(fd: number, buf: Buffer, position: number): number {
  let n = 0
  while (n < buf.length) {
    const got = readSync(fd, buf, n, buf.length - n, position + n)
    if (got === 0) break
    n += got
  }
  return n
}
