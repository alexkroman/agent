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

import { generateObject, InvalidToolInputError, jsonSchema, type LanguageModel } from "ai";

/** Fenced code blocks the model sometimes wraps arguments in. */
const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

/**
 * Best-effort repair of *nearly* valid JSON, without an LLM round trip.
 *
 * Handles, in order: a code fence around the object, trailing commas, raw
 * control characters inside strings (the common one — a real newline where
 * `\n` belonged), and an unterminated tail (closing any string and brackets
 * still open). Returns null when the result still does not parse, so a
 * caller never acts on a half-repaired object.
 */
export function salvageJson(input: string): string | null {
  let text = input.trim();
  const fenced = FENCE.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  const attempts = [text, escapeControlCharsInStrings(text)];
  for (const attempt of attempts) {
    const candidates = [attempt, dropTrailingCommas(attempt)];
    for (const candidate of candidates) {
      const parsed = tryParse(candidate) ?? tryParse(closeOpenStructures(candidate));
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function tryParse(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    // Tool inputs are always objects; a bare string or number means the
    // salvage latched onto a fragment rather than the arguments.
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function dropTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
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

/** Lexical state after walking a (possibly truncated) JSON payload. */
type JsonScanState = { inString: boolean; escaped: boolean; open: string[] };

/** Push/pop the bracket stack for one structural character. */
function trackBracket(open: string[], ch: string): void {
  if (ch === "{" || ch === "[") open.push(ch);
  else if (ch === "}" || ch === "]") open.pop();
}

function scanJsonState(text: string): JsonScanState {
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === '"') inString = !inString;
    else if (!inString) trackBracket(open, ch);
  }
  return { inString, escaped, open };
}

/**
 * Close whatever a truncated payload left open: an unterminated string, then
 * any `{`/`[` still on the stack. Recovers the arguments up to the cut, which
 * for a truncated `write_file` is a partial file — wrong, but the model sees
 * the result and can continue rather than losing the turn.
 */
function closeOpenStructures(text: string): string {
  const { inString, escaped, open } = scanJsonState(text);
  if (!inString && open.length === 0) return text;
  // A dangling backslash would escape the quote we are about to add.
  let out = escaped ? text.slice(0, -1) : text;
  if (inString) out += '"';
  for (let i = open.length - 1; i >= 0; i--) out += open[i] === "{" ? "}" : "]";
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

    const salvaged = salvageJson(toolCall.input);
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
