// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `client-dir`.
 *
 * The prebuilt default client's location on disk — the one export of this
 * package a SERVER calls, and the only one that runs on Node. Its own contract
 * because it is its own published subpath and its own audience: a self-hosted
 * `server.mjs` passing `clientDir` to `createRuntimeServer`.
 *
 * Re-exported from `@alexkroman1/aai-ui/client-dir`. This file is not shipped
 * and nothing imports it — it exists so `pnpm check:api-contracts` can extract
 * a report for this capability alone, hash it, and hold it to a committed
 * epoch. See `scripts/api-contracts.mjs`.
 */

export { defaultClientDir } from "../../client-dir.ts";
