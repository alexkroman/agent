// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `client`.
 *
 * The voice mount: `mountClient()`, the config it accepts, and the handle it hands
 * back. This is the first line of every `client.tsx`.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type ClientConfig,
  type ClientConfigResponse,
  type ClientHandle,
  mountClient,
  type ToolDisplayConfig,
} from "../../index.ts";
