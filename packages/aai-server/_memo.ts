// Copyright 2026 the AAI authors. MIT license.
/**
 * Memoized async initialization that RESETS ON REJECTION.
 *
 * The subtle half of the `promise ??= build()` pattern is the catch: without
 * clearing the memo when the build rejects, one transient failure (a Modal
 * control-plane blip, a DDL error) wedges the caller on a rejected promise
 * for the process lifetime. One implementation so new call sites can't
 * re-derive the pattern without the reset — used by the platform stores'
 * DDL bootstrap (`pg-ensure.ts`), the Modal spawn context, and the harness
 * code/image caches.
 */

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

export type KeyedAsyncMemo<T> = ((key: string, build: () => Promise<T>) => Promise<T>) & {
  /** Drop every memo so the next calls rebuild (tests). */
  clear(): void;
};

/**
 * Keyed variant of {@link memoAsync}: one memo per key, each cleared on its
 * own rejection. The builder is per-call so it can close over more than the
 * key (e.g. the harness image build closes over the bundle code its tag was
 * derived from).
 */
export function keyedMemoAsync<T>(): KeyedAsyncMemo<T> {
  const memo = new Map<string, Promise<T>>();
  const fn = (key: string, build: () => Promise<T>): Promise<T> => {
    let pending = memo.get(key);
    if (!pending) {
      pending = build().catch((err: unknown) => {
        memo.delete(key);
        throw err;
      });
      memo.set(key, pending);
    }
    return pending;
  };
  fn.clear = (): void => memo.clear();
  return fn;
}
