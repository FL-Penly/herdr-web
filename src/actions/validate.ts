import { UserError } from '../server/http.ts'

/** Checks an unknown value and returns it typed, or throws a 400 naming the offending field. */
export type Check<T> = (value: unknown, field: string) => T

function invalid(field: string, what: string): never {
  throw new UserError('bad_request', `${field} must be ${what}`)
}

export function string({
  max = 10_000,
  pattern,
  trim = false,
}: { max?: number; pattern?: RegExp; trim?: boolean } = {}): Check<string> {
  return (v, field) => {
    if (typeof v !== 'string') return invalid(field, 'a string')
    const s = trim ? v.trim() : v
    if (s.length > max) return invalid(field, `at most ${max} characters`)
    if (pattern && !pattern.test(s)) return invalid(field, `in the form ${pattern}`)
    return s
  }
}

export function boolean(): Check<boolean> {
  return (v, field) => (typeof v === 'boolean' ? v : invalid(field, 'true or false'))
}

export function integer(min: number, max: number): Check<number> {
  return (v, field) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
      ? v
      : invalid(field, `an integer ${min}-${max}`)
}

export function oneOf<const T extends string>(values: readonly T[]): Check<T> {
  return (v, field) => (values.includes(v as T) ? (v as T) : invalid(field, `one of ${values.join(', ')}`))
}

export function arrayOf<T>(item: Check<T>, { min = 0, max = 100 } = {}): Check<T[]> {
  return (v, field) => {
    if (!Array.isArray(v) || v.length < min || v.length > max) return invalid(field, `a list of ${min}-${max} items`)
    return v.map((x, i) => item(x, `${field}[${i}]`))
  }
}

/** `undefined` (missing or null) or a checked value. */
export function optional<T>(check: Check<T>): Check<T | undefined> {
  return (v, field) => (v === undefined || v === null ? undefined : check(v, field))
}

type Shape = Record<string, Check<unknown>>
export type Infer<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> }

/** An object with exactly these fields checked; unknown fields are ignored. */
export function object<S extends Shape>(shape: S): Check<Infer<S>> {
  return (v, field) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return invalid(field, 'an object')
    const src = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, check] of Object.entries(shape)) out[key] = check(src[key], key)
    return out as Infer<S>
  }
}
