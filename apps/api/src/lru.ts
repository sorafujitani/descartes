/** Map evicting its oldest entries beyond a count and an optional total weight. */
export class Lru<K, V> {
  private map = new Map<K, V>();
  private weight = 0;
  constructor(
    private maxSize: number,
    private maxWeight = Infinity,
    private weigh: (value: V) => number = () => 0,
  ) {}
  has(key: K) {
    return this.map.has(key);
  }
  /** Reads without changing eviction order. */
  get(key: K) {
    return this.map.get(key);
  }
  /** Reads and marks the entry as most recently used. */
  touch(key: K) {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  /** Inserts as most recent; a value heavier than the whole budget is not stored. */
  set(key: K, value: V) {
    const weight = this.weigh(value);
    if (weight > this.maxWeight) return;
    this.delete(key);
    while (
      this.map.size &&
      (this.map.size >= this.maxSize || this.weight + weight > this.maxWeight)
    )
      this.delete(this.map.keys().next().value as K);
    this.map.set(key, value);
    this.weight += weight;
  }
  delete(key: K) {
    if (!this.map.has(key)) return;
    this.weight -= this.weigh(this.map.get(key)!);
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
    this.weight = 0;
  }
}
