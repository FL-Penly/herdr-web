// @ts-check
import { getJson } from './api.js'

/** @typedef {import('../../src/protocol.ts').ModelCatalog} ModelCatalog */
/** @typedef {{ commands: import('../../src/protocol.ts').Command[]; skills: import('../../src/protocol.ts').Command[] }} CommandCatalog */
/** @template T @typedef {{ at: number; value: T | null; promise: Promise<T> }} Entry */

const COMMANDS_TTL_MS = 60_000
// Codex writes its model list on its first run: ask again a little later while it is missing.
const MISSING_MODELS_TTL_MS = 30_000

/** @type {Map<string, Entry<ModelCatalog>>} */
const models = new Map()
/** @type {Map<string, Entry<CommandCatalog>>} */
const commands = new Map()

/**
 * One request per key and TTL. A failure resolves to `empty()` and is cached like a success,
 * so a broken endpoint is not asked again on every render.
 * @template T
 * @param {Map<string, Entry<T>>} map
 * @param {string} key
 * @param {number | ((value: T | null) => number)} ttl a function gets the cached value (null while loading)
 * @param {() => Promise<T>} load
 * @param {() => T} empty
 */
function cached(map, key, ttl, load, empty) {
  const hit = map.get(key)
  if (hit && Date.now() - hit.at < (typeof ttl === 'function' ? ttl(hit.value) : ttl)) return hit
  /** @type {Entry<T>} */
  const entry = { at: Date.now(), value: null, promise: load().catch(empty) }
  entry.promise.then(value => {
    entry.value = value
  })
  map.set(key, entry)
  return entry
}

/** @returns {ModelCatalog} */
const emptyModels = () => ({ models: [], default: { model: '', effort: '' } })

/** @param {string} kind */
export const modelCatalog = kind =>
  cached(
    models,
    kind,
    value => (value?.unavailable ? MISSING_MODELS_TTL_MS : Number.POSITIVE_INFINITY),
    () =>
      getJson('/api/models', { kind }).then(body => ({
        models: body.models ?? [],
        default: body.default ?? emptyModels().default,
        ...(body.unavailable ? { unavailable: body.unavailable } : {}),
      })),
    emptyModels,
  ).promise

/** @param {string} kind */
export const cachedModelCatalog = kind => models.get(kind)?.value ?? null

/**
 * @param {string} kind
 * @param {string} cwd
 */
export const commandCatalog = (kind, cwd) =>
  cached(
    commands,
    `${kind}|${cwd}`,
    COMMANDS_TTL_MS,
    () =>
      getJson('/api/commands', { kind, cwd: cwd || '' }).then(body => ({
        commands: body.commands ?? [],
        skills: body.skills ?? [],
      })),
    () => ({ commands: [], skills: [] }),
  ).promise
