// Just enough of `window`, `location` and `history` for the modules that read the address and arm Back.
type Entry = { url: string; state: unknown }

export class FakeHistory {
  entries: Entry[]
  index = 0
  readonly window = new EventTarget()

  constructor(href: string) {
    this.entries = [{ url: href, state: null }]
  }

  get href() {
    return this.entries[this.index].url
  }

  get state() {
    return this.entries[this.index].state
  }

  private resolve(url?: string) {
    return url == null || url === '' ? this.href : new URL(url, this.href).href
  }

  replaceState(state: unknown, _title: string, url?: string) {
    this.entries[this.index] = { url: this.resolve(url), state: structuredClone(state) }
  }

  pushState(state: unknown, _title: string, url?: string) {
    this.entries.length = this.index + 1
    this.entries.push({ url: this.resolve(url), state: structuredClone(state) })
    this.index++
  }

  // A same-document traversal: popstate, then hashchange when the fragment differs.
  back() {
    if (this.index === 0) return
    const from = new URL(this.href).hash
    this.index--
    const event = Object.assign(new Event('popstate'), { state: this.state })
    this.window.dispatchEvent(event)
    if (new URL(this.href).hash !== from) this.window.dispatchEvent(new Event('hashchange'))
  }

  install() {
    const fake = this
    Object.defineProperty(globalThis, 'history', { value: this, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'window', { value: this.window, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      get: () => ({
        get href() {
          return fake.href
        },
      }),
    })
  }
}
