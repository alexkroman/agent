// Copyright 2026 the AAI authors. MIT license.
/**
 * One value hung off `globalThis` under a `Symbol.for` key — the rendezvous
 * every process-wide publisher here uses (`step-env.ts` has the argument: the
 * agent bundle and the host hold two copies of the SDK, so a module-level
 * variable in one is invisible to the other, while a registry symbol is the
 * same in both).
 *
 * **The key is a contract between bundles.** Every copy that must share a
 * slot has to spell it identically, so a published key is never renamed.
 *
 * @module _global-slot
 * @internal
 */

/**
 * A handle on one process-wide slot. `set(undefined)` deletes the property
 * rather than storing `undefined`, so an unpublished slot is absent, not blank.
 *
 * @internal
 */
export type GlobalSlot<T> = {
  get(): T | undefined;
  set(value: T | undefined): void;
};

/**
 * The slot at `Symbol.for(key)` on `globalThis`.
 *
 * @internal
 */
export function globalSlot<T>(key: string): GlobalSlot<T> {
  const symbol = Symbol.for(key);
  const holder = globalThis as unknown as Record<symbol, T | undefined>;
  return {
    get: () => holder[symbol],
    set: (value) => {
      if (value === undefined) delete holder[symbol];
      else holder[symbol] = value;
    },
  };
}
