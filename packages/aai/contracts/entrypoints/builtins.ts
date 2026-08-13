// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `builtins`.
 *
 * The keyless network builtins callable directly from tool code.
 *
 * Re-exported from `@alexkroman1/aai/tools`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type CallOptions,
  fetchJson,
  visitWebpage,
  webSearch,
} from "../../host/agent-tools.ts";
