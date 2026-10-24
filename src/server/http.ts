import { HerdrError } from '../herdr.ts'
import { TuiError } from '../tui/index.ts'

/** A request the caller can fix: reported with its code and message, never logged as a server fault. */
export class UserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'UserError'
  }
}

export function ok(data: object = {}): Response {
  return Response.json({ ok: true, ...data })
}

export function fail(status: number, code: string, error: string, data: object = {}): Response {
  return Response.json({ ok: false, error, code, ...data }, { status })
}

export function errorResponse(err: unknown): Response {
  if (err instanceof UserError) return fail(err.status, err.code, err.message)
  // "This dialog changed" and friends: the user acted on a stale view of the screen.
  if (err instanceof TuiError) return fail(400, err.code, err.message, err.data)
  if (err instanceof HerdrError) {
    console.error(err.message)
    return fail(502, 'herdr', err.message)
  }
  console.error(err)
  return fail(500, 'internal', err instanceof Error ? err.message : String(err))
}

/** Run a JSON handler and wrap its result (or its error) in the `Result` envelope. */
export async function wrap(run: () => Promise<object>): Promise<Response> {
  try {
    return ok(await run())
  } catch (err) {
    return errorResponse(err)
  }
}
