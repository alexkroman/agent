// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `db`.
 *
 * An agent's Postgres handle — opening one, and the two shapes a caller
 * gets back depending on whether it must be closed.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  type CloseableDb,
  type CreatePostgresDbOptions,
  createPostgresDb,
  type ReservedDb,
} from "../../runtime-barrel.ts";
