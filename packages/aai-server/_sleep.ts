// Copyright 2026 the AAI authors. MIT license.

/**
 * Timer-based sleep, unref'd so a pending sleep never holds the process
 * open on its own. The package's one implementation — poll loops
 * (platform-lock acquire, drain, guest dial retry) share it instead of
 * re-rolling the timer promise.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
