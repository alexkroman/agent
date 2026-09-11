// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `tool`.
 *
 * Writing a tool: the `tool()` helper, the context its `execute` receives, and
 * the failure shape a tool returns for something the model should recover from
 * — its guard, its constructor, and the `orFail`/`failable` pair that forwards
 * one out of a chain of lookups. All four are here rather than on `utils`
 * because the `T | ToolFailure` union IS what writing a tool is.
 *
 * `ToolErrorHandler` is the fifth member of that group and belongs to the same
 * union from the other side: it is what `ToolDef.onError` takes, so it is how an
 * author says which THROWS are recoverable — turning one into the same
 * `ToolFailure` a returned refusal would have been. It is contracted here rather
 * than on `dialog`, though `DialogToolDef.onError` takes it too: the type is
 * declared beside `ToolDef` and a dialog tool is a tool with a position, so one
 * capability owns the handler and `dialog` owns the def that also accepts one.
 *
 * The six `ToolMessage*` names are here for the same reason `ToolErrorHandler`
 * is: `ToolDef.messages` takes them, so they are how an author says what the
 * agent SAYS while a tool runs and what it says instead of the model when the
 * tool lands. `dialog` owns the def that also accepts one, not the vocabulary.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type DefaultToolResult,
  failable,
  type InferSchemaOutput,
  type InferToolInput,
  type InferToolOutput,
  isToolFailure,
  type Message,
  orFail,
  requireEnv,
  type ToolCompletionMessage,
  type ToolConditionOperator,
  type ToolContext,
  type ToolDef,
  type ToolDelayedMessage,
  type ToolErrorHandler,
  type ToolFailure,
  type ToolInputSchema,
  type ToolMessageCondition,
  type ToolMessages,
  type ToolMessagesInput,
  type ToolStartMessage,
  tool,
  toolFailure,
} from "../../index.ts";
