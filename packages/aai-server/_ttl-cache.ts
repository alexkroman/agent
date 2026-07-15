// Copyright 2026 the AAI authors. MIT license.

import QuickLRU from "quick-lru";

/**
 * Expire-on-read TTL cache with an LRU max-size cap, built on quick-lru.
 *
 * Shared by the bundle store (manifest/config/asset caches) and the
 * PBKDF2 verification cache in `secrets.ts`.
 *
 * Note: quick-lru's dual-generation eviction means the cache may briefly
 * hold up to 2× maxSize entries — the cap is approximate, not exact.
 */
export class TtlCache<V> extends QuickLRU<string, V> {
  constructor(ttlMs: number, maxSize = 10_000) {
    super({ maxSize, maxAge: ttlMs });
  }

  /** Delete every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string): void {
    for (const key of [...this.keys()]) {
      if (key.startsWith(prefix)) this.delete(key);
    }
  }
}
