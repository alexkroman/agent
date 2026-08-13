// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `page`.
 *
 * The workflow-app mount: `page()`, for an `agent({ page: "static" })` front
 * door with no session, no socket and no audio. A second mount rather than a
 * flag on `client()` — see "Workflow apps" in `packages/aai-ui/CLAUDE.md`.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export { type PageConfig, type PageHandle, page } from "../../index.ts";
