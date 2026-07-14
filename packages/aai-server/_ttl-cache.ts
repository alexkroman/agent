// Copyright 2026 the AAI authors. MIT license.

/**
 * Expire-on-read TTL cache with an optional LRU max-size cap.
 *
 * Shared by the bundle store (manifest/config/asset caches) and the
 * PBKDF2 verification cache in `secrets.ts`.
 */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  private readonly ttlMs: number;
  private readonly maxSize: number | undefined;

  constructor(ttlMs: number, maxSize?: number) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return;
    if (entry.expires < Date.now()) {
      this.map.delete(key);
      return;
    }
    if (this.maxSize !== undefined) {
      // Refresh LRU position
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.maxSize !== undefined && this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  /** Delete every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string): void {
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
