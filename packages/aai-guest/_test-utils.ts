// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared test helpers for aai-guest.
 *
 * Only what more than one suite needs. The `vi.mock` factories that install
 * the spawn mocks stay per-file — they are hoisted, so they cannot be shared.
 */

import type { runNpm } from "./studio-spawn.ts";

/** A settled npm run, defaulting to a clean success. */
export const npmResult = (over: Partial<Awaited<ReturnType<typeof runNpm>>> = {}) => ({
  exitCode: 0 as number | null,
  signal: null as NodeJS.Signals | null,
  stdout: "",
  stderr: "",
  ...over,
});
