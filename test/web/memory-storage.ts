// Bun has no localStorage; the browser modules that persist state get an in-memory one.
export function installMemoryStorage(name: 'localStorage' | 'sessionStorage' = 'localStorage'): Map<string, string> {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size
    },
  }
  Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true })
  return data
}
