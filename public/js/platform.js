// @ts-check
// Guarded because i18n/index.js imports this under `bun test` too.
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
