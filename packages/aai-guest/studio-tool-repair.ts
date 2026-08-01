// Copyright 2026 the AAI authors. MIT license.
/**
 * Repairing malformed tool calls from the studio coding agent's model.
 *
 * The default studio model emits tool arguments as a JSON string, and for a
 * `write_file` carrying a whole source file that string is frequently not
 * valid JSON — an unescaped newline, a stray fence, a truncated tail. The AI
 * SDK rejects it with `InvalidToolInputError`, the turn loses the call, and
 * the model responds by apologizing for a "JSON parsing error" and trying
 * again — burning steps and, often, repeating the same mistake.
 *
 * `repairToolCall` is the SDK's hook for exactly this. Two tiers, cheapest
 * first:
 *
 * 1. **Salvage the text.** Most failures are small and mechanical, and
 *    fixing them costs nothing. See {@link salvageJson}.
 * 2. **Ask the model for just the arguments.** When the text is beyond
 *    repair (usually a truncated file), re-request the arguments alone
 *    against the tool's own schema.
 *
 * A hallucinated tool NAME is deliberately not repaired: guessing which tool
 * was meant risks writing a file when the model asked to delete one. That
 * error goes back as-is.
 */

import {
  generateObject,
  InvalidToolInputError,
  jsonSchema,
  type LanguageModel,
  parsePartialJson,
} from "ai";

/** Fenced code blocks the model sometimes wraps arguments in. */
const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

/**
 * Best-effort repair of *nearly* valid JSON, without an LLM round trip.
 *
 * The SDK's own `parsePartialJson` (the streaming partial-object parser) does
 * the structural work — truncated strings, unclosed brackets, trailing
 * commas — so none of that is reimplemented here. It does NOT handle the two
 * shapes the studio model actually produces, which is all this adds:
 *
 * - a raw newline/tab inside a string literal, where `\n` belonged. This is
 *   the common `write_file` break and `parsePartialJson` reports it as a
 *   failed parse.
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

/** Raw control characters that are illegal inside a JSON string literal. */
const CONTROL_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

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

/** The shape of a tool call this module reads and rewrites. */
export type RepairableToolCall = { toolName: string; input: string };

/**
 * Arguments of the AI SDK's repair hook that this module actually uses.
 * Generic over the call so the repaired value keeps the SDK's own type.
 */
export type RepairArgs<T extends RepairableToolCall> = {
  toolCall: T;
  error: unknown;
  /** The tool's JSON Schema, in whatever shape `jsonSchema()` accepts. */
  inputSchema: (options: { toolName: string }) => PromiseLike<Parameters<typeof jsonSchema>[0]>;
};

/**
 * Build the `repairToolCall` handler. `model` is only touched by tier 2, so
 * a repair that salvages the text costs no tokens at all.
 */
export function createToolCallRepair(model: LanguageModel) {
  return async <T extends RepairableToolCall>({
    toolCall,
    error,
    inputSchema,
  }: RepairArgs<T>): Promise<T | null> => {
    // Only malformed *input* is repaired. A hallucinated tool NAME
    // (NoSuchToolError) is left alone: guessing the intended tool is worse
    // than failing — "delete_file" repaired to "write_file" would be a
    // destructive misread.
    if (!InvalidToolInputError.isInstance(error)) return null;

    const salvaged = await salvageJson(toolCall.input);
    if (salvaged !== null) return { ...toolCall, input: salvaged };

    try {
      const schema = await inputSchema({ toolName: toolCall.toolName });
      const { object } = await generateObject({
        model,
        schema: jsonSchema(schema),
        prompt: [
          `The arguments below for the tool "${toolCall.toolName}" are not valid JSON.`,
          "Return the same arguments as valid JSON matching the schema.",
          "Preserve the intended file content exactly; do not summarize or shorten it.",
          "",
          toolCall.input,
        ].join("\n"),
      });
      return { ...toolCall, input: JSON.stringify(object) };
    } catch {
      // Repair is best-effort: fall through to the original error so the
      // model is told the call failed instead of silently losing it.
      return null;
    }
  };
}
