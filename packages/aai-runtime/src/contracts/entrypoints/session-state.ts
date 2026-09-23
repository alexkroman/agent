// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `session-state`.
 *
 * Where a session's slots live between turns: the DDL a self-hosted operator
 * applies to its own database at boot.
 *
 * The backend interface and the store over it used to be here, and left for
 * `@alexkroman1/aai-runtime/internal`: no public option takes a backend or a
 * store (`createRuntime` selects one from the boot env), so the contract was
 * promising epochs on a seam no embedder could reach.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

// The DDL applier a self-hosted operator calls at boot — the other half of
// "the tables come with the database".
export { ensureSessionStateSchema } from "../../runtime-barrel.ts";
