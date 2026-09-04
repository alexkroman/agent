// Copyright 2026 the AAI authors. MIT license.
/**
 * Memoized async initialization that RESETS ON REJECTION.
 *
 * The subtle half of the `promise ??= build()` pattern is the catch: without
 * clearing the memo when the build rejects, one transient failure (a Modal
 * control-plane blip, a DDL error) wedges the caller on a rejected promise
 * for the process lifetime. One implementation so new call sites can't
 * re-derive the pattern without the reset — used by the Modal spawn context
 * and the harness code/image caches.
 *
 * {@link createSingleFlight} below is the same shape with the opposite
 * retention: it dedupes concurrent loads and keeps nothing once they settle.
 */

import { createOwnedMap } from "@alexkroman1/aai/internal";

export type MemoizedAsync<T> = (() => Promise<T>) & {
  /** Drop the memo so the next call rebuilds (tests, explicit invalidation). */
  reset(): void;
};

/** Memoize `build()`: one in-flight/settled promise, cleared on rejection. */
export function memoAsync<T>(build: () => Promise<T>): MemoizedAsync<T> {
  let memo: Promise<T> | null = null;
  const fn = (): Promise<T> => {
    memo ??= build().catch((err: unknown) => {
      memo = null;
      throw err;
    });
    return memo;
  };
  fn.reset = (): void => {
    memo = null;
  };
  return fn;
}

export type SingleFlight<T> = {
  /**
   * Join the load already running for `key`, or start one. The entry lives
   * only for the load's own duration — this dedupes the WINDOW, never the
   * result.
   */
  run(key: string, load: () => Promise<T>): Promise<T>;
  /**
   * Stop later callers joining the load running for `key`. For a key whose
   * underlying value may have changed since that load started — the joiner
   * would otherwise be served a read that predates the change.
   */
  drop(key: string): void;
  /** In-flight count — for tests asserting entries really drain. */
  size(): number;
};

/**
 * Dedupe CONCURRENT loads of the same key, without retaining the result.
 *
 * The distinction from {@link keyedMemoAsync} is the whole point: a memo keeps
 * the settled promise, so it IS the cache. This keeps nothing — it exists for
 * call sites that already have a cache (a TTL row cache, a byte-budgeted blob
 * LRU) and are missing only the window between "N callers miss" and "the first
 * one populates it". On a cold replica that window is where a burst turns into
 * N identical Postgres reads or N identical Storage downloads, which is the
 * one case a cache is there for.
 *
 * Entries are removed by ownership token rather than by key, so a load
 * settling after {@link SingleFlight.drop} replaced its entry cannot evict the
 * successor's.
 */
export function createSingleFlight<T>(): SingleFlight<T> {
  const inFlight = createOwnedMap<string, Promise<T>>();
  return {
    run(key, load) {
      const joined = inFlight.get(key);
      if (joined) return joined;
      const pending = load();
      const release = inFlight.claim(key, pending);
      // Released OUT OF BAND, so every caller receives the load's own promise
      // rather than a `.finally` chain over it. That chain costs a microtask
      // turn per read, and settling one turn later is observable: it pushed
      // the change-stream handler's blue-green handover past the fixed
      // 20-microtask drain the sandbox-resolve specs settle events with. A
      // read on this path should be indistinguishable from an unwrapped one.
      //
      // `then(release, release)` rather than `finally(release)` because a
      // `finally` rejects onward, and nothing awaits THIS promise — it would
      // be an unhandled rejection on every failed read. The load's rejection
      // still reaches callers through the promise they were handed.
      void pending.then(release, release);
      return pending;
    },
    drop(key) {
      inFlight.delete(key);
    },
    size: () => inFlight.size,
  };
}

export type KeyedAsyncMemo<T> = ((key: string, build: () => Promise<T>) => Promise<T>) & {
  /** Drop every memo so the next calls rebuild (tests). */
  clear(): void;
};

/**
 * Keyed variant of {@link memoAsync}: one memo per key, each cleared on its
 * own rejection. The builder is per-call so it can close over more than the
 * key (e.g. the harness image build closes over the bundle code its tag was
 * derived from).
 *
 * The reset is BY OWNERSHIP, like every other keyed teardown here. A build's
 * rejection can land after the key already holds a successor — `clear()`
 * releases the key while a build is still in flight, and the next call claims
 * it — and an unguarded `memo.delete(key)` there evicts that successor. What
 * it costs is a redundant rebuild rather than a wrong answer (the successor's
 * own callers still hold its promise), but for `modal-harness-image.ts` a
 * rebuild is a builder sandbox and a filesystem snapshot. It is reachable only
 * through `clear()` today, which is test-only — the guard is here because
 * `createSingleFlight` two functions up gets this right and a reader has no
 * way to tell which of the two spellings was deliberate.
 */
export function keyedMemoAsync<T>(): KeyedAsyncMemo<T> {
  const memo = createOwnedMap<string, Promise<T>>();
  const fn = (key: string, build: () => Promise<T>): Promise<T> => {
    const joined = memo.get(key);
    if (joined) return joined;
    // Assigned before the catch can run: `claim` is synchronous and a
    // rejection is a microtask at the earliest.
    let release: () => boolean = () => false;
    const pending = build().catch((err: unknown) => {
      release();
      throw err;
    });
    release = memo.claim(key, pending);
    return pending;
  };
  fn.clear = (): void => memo.clear();
  return fn;
}
