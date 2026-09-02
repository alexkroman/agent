// Copyright 2026 the AAI authors. MIT license.
/**
 * Expire-on-read TTL cache with an LRU entry cap.
 *
 * Shared by the bundle store (row/version caches), the access-token
 * verification cache in `supabase-auth.ts`, the API-key cache, the rate
 * limiter's windows, and the studio's two throttles.
 *
 * **Built on `lru-cache`, which this package already depends on** — see
 * `createBlobCache` in `bundle-store.ts`, the byte-budgeted sibling. It used
 * to be `quick-lru`, i.e. two LRU libraries in one package doing overlapping
 * jobs, and the second one cost accuracy: quick-lru's dual-generation eviction
 * holds up to 2x `maxSize` entries, so every cap here was approximate and the
 * three call sites that size against one (`VERIFY_MAX`, `MAX_TRACKED_KEYS`,
 * the studio throttles' 1000) were really naming half a bound. `lru-cache`'s
 * `max` is exact.
 *
 * **`null` is a VALUE here and `undefined` is a MISS**, which is the whole
 * reason this is a wrapper rather than a subclass. `LRUCache<K, V>` constrains
 * `V extends {}`, so it cannot hold either — `bundle-store.ts`'s `BLOB_MISS`
 * is that constraint met head-on. But three caches here deliberately store
 * `null` to mean "asked, and the answer was nothing": a slug with no row
 * (`bundle-store.ts`), a version that does not exist, and a token that failed
 * to verify (`supabase-auth.ts`). Caching that negative is the point — it is
 * what keeps an unknown slug or a bad token from reaching Postgres or gotrue
 * on every request — and every one of those call sites reads the difference as
 * `cached !== undefined`. So `null` goes in under {@link NULL} and comes back
 * out as `null`, and only a genuine miss is `undefined`.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { LRUCache } from "lru-cache";

/**
 * What a stored `null` is kept as.
 *
 * A symbol rather than a string or a shared object so it cannot collide with a
 * value a caller stores: `TtlCache<string>` is a live instantiation
 * (`middleware.ts`, `studio-preview.ts`), and any in-band marker would be a
 * string one of them could legitimately cache.
 */
const NULL = Symbol("ttl-cache-null");

/** How `V` is held, with {@link NULL} standing in for a stored `null`. */
type Stored<V> = NonNullable<V> | typeof NULL;

/** Per-entry overrides for {@link TtlCache.set}. */
export type TtlCacheSetOptions = {
  /**
   * This entry's lifetime, overriding the cache's default.
   *
   * One caller needs it: `verifyAccessToken` expires a VERIFIED token when its
   * own `exp` says to, and keeps the flat TTL for a rejection, which has no
   * `exp` to read.
   */
  ttlMs?: number | undefined;
};

/**
 * A string-keyed cache whose entries expire after `ttlMs` and whose oldest
 * entries are evicted past `max`.
 *
 * Only `get`, `set` and `delete` are exposed, because only those three are
 * used. A wrapper that re-exported the whole `LRUCache` surface would be
 * asserting that the sentinel above survives `entries()`, `peek()`,
 * `forEach()` and the rest, and it does not — every one of them would hand a
 * caller the raw symbol.
 */
export class TtlCache<V> {
  readonly #store: LRUCache<string, Stored<V>>;

  constructor(ttlMs: number, max = 10_000) {
    // `ttl` alone is a construction error in lru-cache without `max` or
    // `ttlAutopurge`; `max` is the one that bounds memory, so it is the one
    // this takes. Expiry is lazy — an entry is dropped when it is read, not on
    // a timer — which is what "expire-on-read" means and why no unref'd
    // interval is created per cache.
    //
    // **The two clock options are what make a TTL here ASSERTABLE**, and both
    // were arrived at by measurement rather than preference. lru-cache reads
    // `performance.now()` by default and memoizes the reading for
    // `ttlResolution` (1ms) behind a `setTimeout`; a spec that installs fake
    // timers moves neither, so an entry stays fresh across any jump. Each
    // option on its own still fails — verified — because they are two
    // independent reasons for the same symptom:
    //
    // - `perf` reads `Date.now()` THROUGH the global on every call, so vitest's
    //   fake `Date` is seen. Passing `Date` itself does not work: it captures
    //   the real constructor at construction, before any spec installs a fake.
    //   It is also exactly the clock quick-lru read, so no cache here changes
    //   behaviour. What it gives up is monotonicity — an NTP step can now move
    //   a TTL — which is the right trade for windows measured in seconds and
    //   read on request paths that already do I/O.
    // - `ttlResolution: 0` drops the memoized reading. Its `setTimeout` is a
    //   REAL timer scheduled before the fake clock exists, so it never fires
    //   and every later staleness check reuses the value cached at `set` time.
    //   The production cost is one `Date.now()` per read instead of one per
    //   millisecond, and the production gain is an entry that cannot be served
    //   up to a millisecond past its expiry.
    //
    // The spec this exists for is `supabase-auth.test.ts`'s "a cached
    // verification never outlives the token's own exp", which advances 10s to
    // prove a 5s-exp token is re-verified rather than served from cache. That
    // is a security property, and the kind that has to stay assertable.
    this.#store = new LRUCache({
      max,
      ttl: ttlMs,
      ttlResolution: 0,
      perf: { now: () => Date.now() },
    });
  }

  /** The cached value, `null` if that is what was cached, `undefined` on a miss. */
  get(key: string): V | undefined {
    const held = this.#store.get(key);
    if (held === undefined) return undefined;
    return held === NULL ? (null as V) : held;
  }

  set(key: string, value: V, options?: TtlCacheSetOptions): void {
    if (value === undefined) {
      // lru-cache treats `set(k, undefined)` as a no-op, so without this the
      // write would silently not happen and the next `get` would read as a
      // miss — a cache that looks like it is working and never hits. No typed
      // caller can reach this (`V` is never `undefined` at any instantiation);
      // it is here so an untyped one fails loudly instead.
      throw new TypeError("TtlCache cannot store undefined — use null for a cached absence.");
    }
    // `omitUndefined` rather than a presence ternary (guard-invariants rule 2),
    // and it is not cosmetic here: `exactOptionalPropertyTypes` makes
    // `{ ttl: undefined }` unassignable to lru-cache's `ttl?: Milliseconds`,
    // and an ABSENT `ttl` is what falls back to the cache's own.
    this.#store.set(
      key,
      value === null ? NULL : (value as NonNullable<V>),
      omitUndefined({ ttl: options?.ttlMs }),
    );
  }

  delete(key: string): void {
    this.#store.delete(key);
  }
}
