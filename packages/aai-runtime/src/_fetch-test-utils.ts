// Copyright 2025 the AAI authors. MIT license.

/**
 * Narrow a test double to `fetch`'s type, in ONE place: a fake never matches
 * `typeof globalThis.fetch` structurally (`RequestInfo | URL`, a full
 * `Response`, `preconnect`), and a cast per call site is the alternative.
 */
export function fakeFetch(
  fn: (url: string, init: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  // One CHECKED cast: `fetch` is assignable to `fn`'s narrower type, so the
  // compiler still relates the two.
  return fn as typeof globalThis.fetch;
}
