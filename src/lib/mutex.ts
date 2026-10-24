/** One queue per key: `run` calls with the same key never overlap and run in call order. */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const result = prev.then(fn).finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    const tail = result.then(
      () => {},
      () => {},
    )
    this.tails.set(key, tail)
    return result
  }

  busy(key: string): boolean {
    return this.tails.has(key)
  }
}
