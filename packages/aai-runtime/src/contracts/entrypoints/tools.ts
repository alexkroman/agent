// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `tools`.
 *
 * How a host that has a filesystem — rather than a bundler — finds the tools
 * an agent serves, and attaches them to the definition it runs.
 *
 * Its own capability and not part of `runtime`: this is about assembling the
 * DEFINITION, which is `createRuntime`'s input rather than any of its shape, so
 * a change to how discovery is spelled has no business bumping the contract a
 * host embeds the engine through.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export { withToolsDir } from "../../runtime-barrel.ts";
