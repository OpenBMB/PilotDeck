/**
 * Tiny LRU map: insertion-order Map + on-get refresh.
 * Used by the worktree resolution chain to memoize per-cwd results.
 *
 * Why not a npm dep: keeps `src/session/worktree/` zero-deps and fits one file.
 * Behaviour is byte-stable across Node versions: relies on Map's insertion-order
 * iteration, guaranteed by the spec (ECMA-262 §24.1).
 */
export class LRUMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`LRUMap: capacity must be positive, got ${capacity}`);
    }
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      return undefined;
    }
    const value = this.map.get(key) as V;
    // Refresh recency: delete then re-insert puts it at the tail.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
