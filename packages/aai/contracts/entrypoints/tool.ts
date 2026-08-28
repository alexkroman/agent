// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `tool`.
 *
 * Writing a tool: the `tool()` helper, the context its `execute` receives, and
 * the failure shape a tool returns for something the model should recover from.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type DefaultToolResult,
  type InferSchemaOutput,
  type InferToolInput,
  type InferToolOutput,
  isToolFailure,
  type Message,
  requireEnv,
  type ToolContext,
  type ToolDef,
  type ToolFailure,
  type ToolInputSchema,
  tool,
  toolFailure,
} from "../../index.ts";
