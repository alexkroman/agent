// Copyright 2025 the AAI authors. MIT license.

/** Loggers for specs: one that discards, and one whose methods are spies. */

import { type Mock, vi } from "vitest";
import type { LogFn, Logger, LogLevel } from "./runtime-config.ts";

/**
 * A logger that discards, to keep test output quiet. Plain no-ops, so it is
 * NOT for asserting on — use {@link makeLogger}. Declared in
 * `runtime-config.ts`, which the fuzz harnesses (not declaration-portable
 * against vitest) can import.
 */
export { silentLogger } from "./runtime-config.ts";

/**
 * A {@link Logger} whose four methods are spies. DECLARED rather than inferred:
 * an inferred `vi.fn()` type names `@vitest/spy` internals the declaration emit
 * cannot (`TS2883`). `Mock<LogFn>` for the call log, `Logger` for assignability.
 */
export type TestLogger = Record<LogLevel, Mock<LogFn>> & Logger;

/** Fresh logger with per-call `vi.fn()` spies. Use whenever you assert on log output. */
export function makeLogger(): TestLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
