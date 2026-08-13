// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool-call repair for every `streamText` loop this SDK drives — the voice
 * pipeline and {@link createTextAgent} alike.
 *
 * When the model emits a tool call whose arguments don't parse, or parse but
 * don't match the tool's input schema, the AI SDK fails the call and the turn
 * loses it: the model is told nothing useful, apologizes for a "JSON parsing
 * error", and retries — usually making the same mistake, having burned a step.
 * `repairToolCall` is the SDK's hook for exactly that, and this is the one
 * implementation of it.
 *
 * Two tiers, cheapest first:
 *
 * 1. **Salvage the text**, when the arguments are not valid JSON at all. Most
 *    of those failures are small and mechanical and cost nothing to fix —
 *    see {@link salvageJson}.
 * 2. **Re-ask the model for just the arguments**, constrained to the tool's
 *    own JSON Schema. This is the only tier that can fix arguments that
 *    PARSED and still failed validation, and the only one that costs tokens.
 *
 * A hallucinated tool NAME is deliberately never repaired: guessing which
 * tool was meant risks writing a file when the model asked to delete one, so
 * `NoSuchToolError` is passed through unchanged (`null`).
 *
 * Tier 1 came from the studio coding agent, which had its own copy of this
 * module. It is not a studio-shaped problem: a whole source file inside a
 * JSON string is simply the largest tool argument anything sends, and an
 * unescaped newline in one is the most common way a tool call breaks —
 * measured on the studio's own model, it is most of what tier 2 was being
 * paid to fix.
 */

import {
  generateObject,
  InvalidToolInputError,
  jsonSchema,
  type LanguageModel,
  NoSuchToolError,
  parsePartialJson,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";
import { errorMessage } from "../sdk/utils.ts";
import type { Logger } from "./runtime-config.ts";

/** Fenced code blocks the model sometimes wraps arguments in. */
const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

/** Raw control characters that are illegal inside a JSON string literal. */
const CONTROL_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/**
 * Best-effort repair of *nearly* valid JSON, without an LLM round trip.
 *
 * The AI SDK's own `parsePartialJson` (the streaming partial-object parser)
 * does the structural work — truncated strings, unclosed brackets, trailing
 * commas — so none of that is reimplemented here. It does NOT handle the two
 * shapes models actually produce, which is all this adds:
 *
 * - a raw newline/tab inside a string literal, where `\n` belonged. This is
 *   the common whole-file-argument break, and `parsePartialJson` reports it
 *   as a failed parse.
 * - a markdown fence wrapped around the arguments.
 *
 * Returns null when the result still does not parse, or parses to something
 * that is not an object, so a caller never hands a fragment to a tool.
 */
export async function salvageJson(input: string): Promise<string | null> {
  let text = input.trim();
  const fenced = FENCE.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  for (const candidate of [text, escapeControlCharsInStrings(text)]) {
    const { value, state } = await parsePartialJson(candidate);
    if (state !== "successful-parse" && state !== "repaired-parse") continue;
    // Tool inputs are always objects; a scalar or array means the salvage
    // latched onto a fragment rather than the arguments.
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    return JSON.stringify(value);
  }
  return null;
}

/**
 * Escape raw control characters that appear *inside* string literals. A
 * literal newline in a JSON string is the single most common way a model's
 * file content breaks the parse.
 */
function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    out += escaped || !inString ? ch : (CONTROL_ESCAPES[ch] ?? ch);
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    }
  }
  return out;
}

/** Did these arguments fail to PARSE, as opposed to failing validation? */
function isUnparsable(input: string): boolean {
  try {
    JSON.parse(input);
    return false;
  } catch {
    return true;
  }
}

/**
 * Build a `ToolCallRepairFunction` bound to `model`. `null` return means
 * "not repairable" — the SDK then surfaces the original error.
 *
 * `getAbortSignal` supplies the in-flight turn's abort signal so the tier-2
 * `generateObject` call is cancelled on barge-in / cancel / disconnect.
 * Without it, a repair kicked off mid-turn keeps running (a billed background
 * LLM call) after the turn that needed it has already been aborted.
 */
export function createToolCallRepair(
  model: LanguageModel,
  log: Logger,
  getAbortSignal?: () => AbortSignal | undefined,
): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, error, inputSchema }) => {
    // An unknown tool can't be repaired by fixing arguments.
    if (NoSuchToolError.isInstance(error)) return null;

    // Tier 1, and gated on the arguments really being unparsable. Arguments
    // that PARSED and failed the schema are already an object, so salvaging
    // them returns the same object and spends the one repair this call gets
    // on a no-op — the model tier is the only one that can fix those.
    if (InvalidToolInputError.isInstance(error) && isUnparsable(toolCall.input)) {
      const salvaged = await salvageJson(toolCall.input);
      if (salvaged !== null) return { ...toolCall, input: salvaged };
    }

    try {
      const schema = await inputSchema({ toolName: toolCall.toolName });
      const abortSignal = getAbortSignal?.();
      const { object } = await generateObject({
        model,
        schema: jsonSchema(schema),
        ...(abortSignal ? { abortSignal } : {}),
        prompt:
          `The tool "${toolCall.toolName}" was called with arguments that failed schema ` +
          `validation:\n${error.message}\n\nInvalid arguments:\n${toolCall.input}\n\n` +
          `Regenerate the arguments so they satisfy the tool's schema, preserving the ` +
          "original intent exactly. Reproduce any file content verbatim — never " +
          "summarize or shorten it — and do not invent values that were not present.",
      });
      return { ...toolCall, input: JSON.stringify(object) };
    } catch (err) {
      // Repair itself failed — let the original tool error stand.
      log.warn("tool-call repair failed", {
        tool: toolCall.toolName,
        error: errorMessage(err),
      });
      return null;
    }
  };
}
