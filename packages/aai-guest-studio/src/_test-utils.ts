// Copyright 2026 the AAI authors. MIT license.
/**
 * Test helpers only this package needs.
 *
 * The shared ones are `aai-guest-core/test-utils`; `npmResult` cannot join
 * them because it fixtures the result of THIS package's `runNpm`, and core
 * may not import the package that depends on it.
 */

import type { runNpm } from "./spawn.ts";
/** A settled npm run, defaulting to a clean success. */
export const npmResult = (over: Partial<Awaited<ReturnType<typeof runNpm>>> = {}) => ({
  exitCode: 0 as number | null,
  signal: null as NodeJS.Signals | null,
  stdout: "",
  stderr: "",
  ...over,
});
