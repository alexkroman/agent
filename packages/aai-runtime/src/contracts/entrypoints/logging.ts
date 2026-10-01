// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `logging`.
 *
 * The logger a host passes in. (The guest's log ring moved to
 * `@alexkroman1/aai/host-internal`: the guest harness, its one user, carries
 * no runtime.)
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export type {
  LogContext,
  LogFn,
  Logger,
  LogLevel,
} from "../../runtime-barrel.ts";
