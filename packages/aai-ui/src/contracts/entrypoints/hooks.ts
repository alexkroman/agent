// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `hooks`.
 *
 * What a client reads off the agent rather than off the session: the state a
 * tool synced, the tool calls as they start and settle, and the custom events
 * `ctx.send` puts on the wire.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type ToolCallInfo,
  useAgentState,
  useEvent,
  useToolCallStart,
  useToolResult,
} from "../../index.ts";
