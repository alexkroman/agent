// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `keys`.
 *
 * Where a workflow's signing keys live: the store interface, its two
 * implementations, and the resolver that picks between them.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  createMemoryKeyStore,
  createPostgresKeyStore,
  resolveKeyStore,
  type WorkflowKeyStore,
} from "../../runtime-barrel.ts";
