// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool-call repair for the pipeline's `streamText` loop.
 *
 * When the model emits a tool call whose arguments don't parse or don't match
 * the tool's input schema, the SDK would normally fail the call. Instead, this
 * repair function re-asks the same model — constrained to the tool's JSON
 * Schema via {@link generateObject} — to regenerate valid arguments for the
 * SAME intent, then hands the corrected call back to the loop. Only
 * schema/parse errors (`InvalidToolInputError`) are repaired; an unknown tool
 * (`NoSuchToolError`) can't be fixed and is passed through (returns `null`).
 */

import {
  generateObject,
  jsonSchema,
  type LanguageModel,
  NoSuchToolError,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";
import type { Logger } from "../runtime-config.ts";

/**
 * Build a {@link ToolCallRepairFunction} bound to `model`. `null` return means
 * "not repairable" — the SDK then surfaces the original error.
 */
export function createToolCallRepair(
  model: LanguageModel,
  log: Logger,
): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, error, inputSchema }) => {
    // An unknown tool can't be repaired by fixing arguments.
    if (NoSuchToolError.isInstance(error)) return null;
    try {
      const schema = await inputSchema({ toolName: toolCall.toolName });
      const { object } = await generateObject({
        model,
        schema: jsonSchema(schema),
        prompt:
          `The tool "${toolCall.toolName}" was called with arguments that failed schema ` +
          `validation:\n${error.message}\n\nInvalid arguments:\n${toolCall.input}\n\n` +
          `Regenerate the arguments so they satisfy the tool's schema, preserving the ` +
          "original intent exactly. Do not invent values that were not present.",
      });
      return { ...toolCall, input: JSON.stringify(object) };
    } catch (err) {
      // Repair itself failed — let the original tool error stand.
      log.warn("tool-call repair failed", {
        tool: toolCall.toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}
