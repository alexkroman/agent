// Copyright 2025 the AAI authors. MIT license.

/**
 * Run a Vite build without letting it mutate the calling process's env.
 *
 * Vite's `build()` sets `process.env.NODE_ENV = "production"` when NODE_ENV is
 * unset — a global, permanent side effect on whatever process invoked it. That
 * is fine for a one-shot `aai build`, but both long-lived callers are broken by
 * it:
 *
 * - `aai dev` rebuilds on every file change, so the first rebuild would flip
 *   the dev server into production mode.
 * - The platform studio builds inside the server process, where flipping
 *   NODE_ENV switches the server into production behavior (strict credential
 *   and storage checks) and breaks every subsequent deploy on a dev machine.
 *
 * Snapshot and restore rather than pinning a value: callers that legitimately
 * run with NODE_ENV=production must keep it.
 *
 * The snapshot is refcounted, not per-call: both bundle paths run the worker
 * and client builds concurrently (`Promise.all`), and independent snapshots
 * interleave — the second entrant would snapshot the "production" the first
 * build's Vite just set, and "restore" it after the first exiter deleted it,
 * flipping the process permanently anyway. So the first entrant snapshots,
 * later entrants just join, and only the last exiter restores. This keeps the
 * builds parallel (a mutex serializing them would cost real deploy time).
 */
let activeBuilds = 0;
let savedNodeEnv: string | undefined;

/**
 * `env` is injectable for tests ONLY, so specs can exercise the
 * snapshot/refcount logic on a plain object instead of mutating (and
 * repeatedly deleting) the real `process.env.NODE_ENV` mid-suite.
 */
export async function withPreservedNodeEnv<T>(
  fn: () => Promise<T>,
  env: { NODE_ENV?: string } = process.env,
): Promise<T> {
  if (activeBuilds === 0) savedNodeEnv = env.NODE_ENV;
  activeBuilds++;
  try {
    return await fn();
  } finally {
    activeBuilds--;
    if (activeBuilds === 0) {
      if (savedNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = savedNodeEnv;
    }
  }
}
