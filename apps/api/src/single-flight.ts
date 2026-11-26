/** Shares one in-flight promise per key with callers presenting the same tag. */
export class SingleFlight<K, T, Tag = undefined> {
  private running = new Map<K, { tag: Tag; promise: Promise<T> }>();
  /** The in-flight promise for `key`, whatever its tag. */
  peek(key: K): Promise<T> | undefined {
    return this.running.get(key)?.promise;
  }
  async run(key: K, tag: Tag, task: () => Promise<T>): Promise<T> {
    const running = this.running.get(key);
    if (running && running.tag === tag) return running.promise;
    const promise = task();
    this.running.set(key, { tag, promise });
    try {
      return await promise;
    } finally {
      // A newer flight for a different tag may have replaced this one.
      if (this.running.get(key)?.promise === promise) this.running.delete(key);
    }
  }
}
