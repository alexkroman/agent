// Copyright 2026 the AAI authors. MIT license.
/**
 * A thenable, recognised STRUCTURALLY — the one spelling of "would `await`
 * on this do anything?".
 *
 * Structural rather than `instanceof Promise` because an async function in a
 * bundle with its own Promise realm (an agent bundle carries its own SDK copy;
 * see "The bundle/runtime boundary" in `packages/aai/CLAUDE.md`) still
 * answers a thenable, and `instanceof` across realms answers `false`. Three
 * private copies had grown — the step classifier, `fatalOn`, the slot tools'
 * synchronous-window check — and a fourth in `aai-runtime`'s error policy,
 * each one line and each a place the realm trap could be re-derived wrong.
 *
 * @module is-thenable
 */

/** Does `value` carry a callable `then`? */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}
