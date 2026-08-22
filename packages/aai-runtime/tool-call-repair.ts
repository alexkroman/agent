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
 *    of those failures are small and mechanical and cost nothing to fix — the
 *    AI SDK's `parsePartialJson` for structure, then `jsonrepair` for the rest.
 *    See {@link salvageJson}.
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

import { errorMessage, isRecord, omitUndefined, safeJsonParse } from "@alexkroman1/aai/utils";
import {
  generateText,
  InvalidToolInputError,
  jsonSchema,
  type LanguageModel,
  NoSuchToolError,
  Output,
  parsePartialJson,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";
import { jsonrepair } from "jsonrepair";
import type { Logger } from "./runtime-config.ts";

/** What {@link parseToolInput} returns for an object with no fields. */
const EMPTY_ARGS = "{}";

/**
 * Best-effort repair of *nearly* valid JSON, without an LLM round trip.
 *
 * Two passes, cheapest first. The AI SDK's own `parsePartialJson` (the streaming
 * partial-object parser) is tried as-is, since the arguments may already be
 * parseable or need only the structural repair it does — truncated strings,
 * unclosed brackets, trailing commas. Anything it rejects goes through
 * `jsonrepair`, which replaces the two hand-rolled pre-passes this module used
 * to carry:
 *
 * - **A raw newline/tab inside a string literal, where `\n` belonged.** The
 *   common whole-file-argument break, and most of what tier 2 was being paid to
 *   fix. It was a hand-written character scanner tracking `inString`/`escaped`.
 * - **A markdown fence around the arguments.** It was an anchored regex, so it
 *   only ever matched a fence wrapping the WHOLE payload.
 *
 * `jsonrepair` covers both (verified against 3.15.0, tagged and bare fences
 * alike) plus a good deal this never handled and models do emit: single-quoted
 * strings, unquoted keys, Python's `None`/`True`/`False`, comments, and
 * concatenated string literals. It is ISC, dependency-free, and the repair is
 * only reached once a parse has already failed, so the ordinary path pays
 * nothing for it.
 *
 * Returns null when the result still does not parse, or parses to something that
 * is not an object, so a caller never hands a fragment to a tool.
 */
export async function salvageJson(input: string): Promise<string | null> {
  const text = input.trim();
  const asIs = await parseToolInput(text);
  // A non-empty object is a real answer, and the repair pass is skipped.
  if (asIs !== null && asIs !== EMPTY_ARGS) return asIs;
  // An EMPTY one is not, and preferring the repair over it is load-bearing:
  // `parsePartialJson` answers `{path:"a.ts"}` (an unquoted key) with
  // `repaired-parse` and a value of `{}`, discarding the field rather than
  // reporting a failure. Taken as the answer that hands the tool EMPTY
  // arguments, and nothing anywhere says so — the model is told the call
  // succeeded, so it does not retry. `jsonrepair` recovers the field.
  const repaired = await repairToolInput(text);
  // `{}` survives as the fallback for the case where it really is the whole
  // argument object — a tool that takes none.
  return repaired ?? asIs;
}

/** Parse `text` after a `jsonrepair` pass, or null if either step gives up. */
async function repairToolInput(text: string): Promise<string | null> {
  let repaired: string;
  try {
    repaired = jsonrepair(text);
  } catch {
    // `JSONRepairError` — not repairable at all, so the caller falls through to
    // the model tier. Caught rather than propagated because a repair hook that
    // throws loses the original tool error, which is the one worth reporting.
    return null;
  }
  return parseToolInput(repaired);
}

/**
 * Parse one candidate to a tool-input object, or null.
 *
 * Both passes land here so the object guard is stated once: tool inputs are
 * always objects, and a scalar or array means the salvage latched onto a
 * fragment rather than the arguments. `jsonrepair` makes that guard load-bearing
 * rather than defensive — it happily turns `this is not json` into the valid
 * JSON string `"this is not json"`, which parses and is still not arguments.
 */
async function parseToolInput(candidate: string): Promise<string | null> {
  const { value, state } = await parsePartialJson(candidate);
  if (state !== "successful-parse" && state !== "repaired-parse") return null;
  if (!isRecord(value)) return null;
  return JSON.stringify(value);
}

/** Did these arguments fail to PARSE, as opposed to failing validation? */
function isUnparsable(input: string): boolean {
  // `undefined` is unambiguous as "did not parse": JSON cannot encode it, so it
  // is `safeJsonParse` reporting malformed input rather than a parsed value.
  return safeJsonParse(input) === undefined;
}

/**
 * Build a `ToolCallRepairFunction` bound to `model`. `null` return means
 * "not repairable" — the SDK then surfaces the original error.
 *
 * `getAbortSignal` supplies the in-flight turn's abort signal so the tier-2
 * `generateText` call is cancelled on barge-in / cancel / disconnect.
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
      // `generateText` + `Output.object`, not `generateObject` — the latter is
      // deprecated as of ai 7.0.62 in favour of exactly this.
      const { output } = await generateText({
        model,
        output: Output.object({ schema: jsonSchema(schema) }),
        ...omitUndefined({ abortSignal }),
        prompt:
          `The tool "${toolCall.toolName}" was called with arguments that failed schema ` +
          `validation:\n${error.message}\n\nInvalid arguments:\n${toolCall.input}\n\n` +
          `Regenerate the arguments so they satisfy the tool's schema, preserving the ` +
          "original intent exactly. Reproduce any file content verbatim — never " +
          "summarize or shorten it — and do not invent values that were not present.",
      });
      return { ...toolCall, input: JSON.stringify(output) };
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
