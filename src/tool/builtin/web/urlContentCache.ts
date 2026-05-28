/**
 * URL content cache for `web_fetch` (W8).
 *
 * Legacy uses `lru-cache` with `maxSize: 50 MB` and `ttl: 15 min`. Since we
 * don't want to add a new dependency, this is a hand-rolled LRU with the
 * same shape:
 *   - Per-entry byte size used for total byte accounting.
 *   - Total bytes capped at MAX_CACHE_SIZE_BYTES.
 *   - Time-to-live enforced on read (lazy expiry).
 *
 * Behaviour parity reference: §5.2 W8.
 */

export type FetchedCacheEntry = {
  bytes: number;
  code: number;
  codeText: string;
  content: string;
  contentType: string;
  persistedPath?: string;
  persistedSize?: number;
};

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024;

type CacheNode = {
  entry: FetchedCacheEntry;
  size: number;
  expiresAt: number;
};

class WebFetchUrlCache {
  private map = new Map<string, CacheNode>();
  private totalBytes = 0;

  get(url: string): FetchedCacheEntry | undefined {
    const node = this.map.get(url);
    if (!node) return undefined;
    if (Date.now() >= node.expiresAt) {
      this.map.delete(url);
      this.totalBytes -= node.size;
      return undefined;
    }
    this.map.delete(url);
    this.map.set(url, node);
    return node.entry;
  }

  set(url: string, entry: FetchedCacheEntry, contentBytes: number): void {
    const size = Math.max(1, contentBytes);
    if (size > MAX_CACHE_SIZE_BYTES) return;

    const existing = this.map.get(url);
    if (existing) {
      this.totalBytes -= existing.size;
      this.map.delete(url);
    }

    while (this.totalBytes + size > MAX_CACHE_SIZE_BYTES) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (oldest) this.totalBytes -= oldest.size;
    }

    this.map.set(url, { entry, size, expiresAt: Date.now() + CACHE_TTL_MS });
    this.totalBytes += size;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }
}

export const URL_CACHE = new WebFetchUrlCache();

export function clearWebFetchCache(): void {
  URL_CACHE.clear();
}

export const WEB_FETCH_CACHE_TTL_MS = CACHE_TTL_MS;
export const WEB_FETCH_MAX_CACHE_BYTES = MAX_CACHE_SIZE_BYTES;
