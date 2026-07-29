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
 *   NODE_ENV makes the sandbox demand gVisor ("gVisor (runsc) is required in
 *   production but not found on PATH") and refuse every subsequent deploy on a
 *   dev machine.
 *
 * Snapshot and restore rather than pinning a value: callers that legitimately
 * run with NODE_ENV=production must keep it.
 */
export async function withPreservedNodeEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.NODE_ENV;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}
