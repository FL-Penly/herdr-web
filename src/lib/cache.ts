/** A Map whose entries expire, bounded to `max` entries (oldest evicted first). */
export class TtlCache<K, V> {
  private map = new Map<K, { at: number; value: V }>()
  private inflight = new Map<K, Promise<V>>()

  constructor(
    private ttlMs: number,
    private max = 500,
  ) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: K, value: V): V {
    this.map.delete(key)
    this.map.set(key, { at: Date.now(), value })
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K)
    return value
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  /** Get, or compute once even when called concurrently. */
  async getOrLoad(key: K, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    let pending = this.inflight.get(key)
    if (!pending) {
      pending = load().finally(() => this.inflight.delete(key))
      this.inflight.set(key, pending)
    }
    return this.set(key, await pending)
  }
}
