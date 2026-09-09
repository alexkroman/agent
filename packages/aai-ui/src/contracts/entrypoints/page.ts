// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `page`.
 *
 * The workflow-app mount: `mountPage()`, for an `agent({ page: "static" })` front
 * door with no session, no socket and no audio. A second mount rather than a
 * flag on `mountClient()` — see "Workflow apps" in `packages/aai-ui/CLAUDE.md`.
 *
 * `fetchClientConfig` belongs here for the same reason: it is the page's
 * replacement for the `GET client-config` lookup each mount performs for the
 * shell it renders itself. A page with its own `component` — which replaces the
 * generated shell, and with it that lookup — has no other way to read the
 * agent's declared `name` or `greeting`.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export { fetchClientConfig, mountPage, type PageConfig, type PageHandle } from "../../index.ts";
