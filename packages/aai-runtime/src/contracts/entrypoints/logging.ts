// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `logging`.
 *
 * The logger a host passes in, and the ring buffer a deployment reads a
 * sandbox's output out of.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  createLogBuffer,
  DEFAULT_LOG_BUFFER_LINES,
  DEFAULT_LOG_LINE_BYTES,
  DEFAULT_LOG_PAGE_LINES,
  LOG_LINE_TRUNCATED,
  type LogBuffer,
  type LogBufferOptions,
  type LogContext,
  type LogFn,
  type Logger,
  type LogLevel,
  type LogLine,
  type LogPage,
  type LogStream,
} from "../../runtime-barrel.ts";
