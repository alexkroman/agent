// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `session-state`.
 *
 * Where a session's slots live between turns — the backend interface and
 * the store over it.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export type {
  SessionStateBackend,
  SessionStateStore,
} from "../../runtime-barrel.ts";
