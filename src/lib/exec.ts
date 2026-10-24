import type { Subprocess } from 'bun'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string | undefined>
}

/** Run a command to completion. A missing binary is a failed run (code 127), not a thrown error. */
export async function exec(cmd: string[], { cwd, timeoutMs = 10_000, env }: ExecOptions = {}): Promise<ExecResult> {
  let proc: Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  } catch (err) {
    return { code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, stdout, stderr, timedOut }
}
