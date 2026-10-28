// Copyright 2026 the AAI authors. MIT license.
/**
 * Checks a call's arguments against the tool's DECLARED parameters before it
 * runs — the half of validation the declaration alone can settle — and
 * explains a failure the arguments make obvious.
 *
 * ## Why the runtime does this itself
 *
 * A host or MCP tool's JSON Schema reaches the model through the AI SDK's
 * `jsonSchema()` with no validator, so `required` and undeclared parameters are
 * never enforced: `find_user_id_by_name_zip({ email: "unknown" })` went to the
 * tau2 harness, which answered with a Python `unexpected keyword argument`. And
 * models fill a value they don't have with a placeholder — 27 of 240 failed
 * calls on a tau2 retail run carried `""`, `"unknown"` or `"?"` in a required
 * argument, every one answered `User not found`, which reads as "no such
 * account" rather than "you sent nothing".
 *
 * The AI SDK's `repairToolCall` (`call-repair.ts`) is the wrong tool for both:
 * it re-asks the model for schema-valid arguments, which for a lookup means
 * inventing the value the caller never gave, and it may never change the tool.
 * The right move is the caller's — ask, or use another tool — so the model is
 * TOLD, as the call's result.
 *
 * ## What is refused, and what is only explained
 *
 * - **Refused before it runs** ({@link precheckToolArgs}): a required parameter
 *   absent (or `null`), or sent as an empty or whitespace string where the
 *   parameter gives no sign empty is an answer (see below); a parameter the
 *   tool does not declare, but only where
 *   the schema says `additionalProperties: false` (elsewhere a stray key is
 *   named as a hint in a refusal for something else); or a placeholder token as
 *   a string value — unless the parameter's own `enum`/`const` names it.
 * - **Explained after it fails** ({@link emptyArgsNote}): a required string
 *   sent EMPTY where the parameter DOES say empty is an answer. An empty
 *   required string can be real — tau2's `address2: ""` is "no second address
 *   line" — and this used to be the rule for every empty string, on the view
 *   that the declaration cannot say which. It usually can: `address2` is
 *   described "such as 'Apt 1' or ''", while `email`, `last_name` and
 *   `order_id` name no empty value. So an empty value is refused unless the
 *   parameter's `enum` holds `""` or its description names an empty value
 *   (`''`, `""`, "empty"); a call that still fails with one is told why.
 */

import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import { isRecord } from "@alexkroman1/aai/utils";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

/**
 * Tokens that stand in for a value the model does not have. Lowercase, compared
 * after trimming. Deliberately NOT `"none"` or `"0"`: both are ordinary answers.
 */
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "?",
  "??",
  "???",
  "unknown",
  "n/a",
  "na",
  "tbd",
  "placeholder",
  "null",
  "undefined",
]);

/**
 * A required string sent EMPTY (or whitespace) is a value the model did not
 * have, the same as one left out: recorded on tau2-bench retail as
 * `find_user_id_by_email({ email: " " })` and `last_name: ""`, each a lookup
 * that could only fail, costing a round trip and reading to the model as "no
 * such caller". Unless the parameter says empty is a real answer — its `enum`
 * holds `""`, or its description names an empty value (tau2's `address2`:
 * "such as 'Apt 1' or ''") — where refusing would block a correct call.
 */
function isBlankWhereValueNeeded(def: JSONSchema7Definition | undefined, value: unknown): boolean {
  if (typeof value !== "string" || value.trim() !== "") return false;
  if (!isRecord(def)) return true;
  if (Array.isArray(def.enum) && def.enum.includes("")) return false;
  const description = typeof def.description === "string" ? def.description : "";
  return !/''|""|\bempty\b/i.test(description);
}

/** The refusal's `reason` — the one schema refusals already use. */
const INVALID_ARGUMENTS = "invalid_arguments";

/**
 * A refusal to answer the call with instead of running it, or `undefined` to
 * run it. `schema` is the tool's declared parameters; absent, nothing is
 * checked.
 *
 * @internal
 */
export function precheckToolArgs(
  name: string,
  args: Readonly<Record<string, unknown>>,
  schema: JSONSchema7 | undefined,
): string | undefined {
  if (schema === undefined) return undefined;
  const properties = schema.properties ?? {};
  const declared = Object.keys(properties);
  const takes = declared.length > 0 ? `${name} takes: ${declared.join(", ")}.` : "";

  // A stray key is only a HINT unless the schema closes the object: an
  // authored zod tool strips extras and runs, and refusing them would turn a
  // harmless key into a wasted round trip.
  const undeclared = Object.keys(args).filter((key) => !(key in properties));
  const stray = undeclared.length > 0 ? ` It has no parameter ${quoteList(undeclared)}.` : "";
  const otherTool =
    undeclared.length > 0 ? " If a value belongs to another tool, call that tool." : "";

  const missing = (schema.required ?? []).filter(
    (key) =>
      args[key] === undefined ||
      args[key] === null ||
      isBlankWhereValueNeeded(properties[key], args[key]),
  );
  if (missing.length > 0) {
    return refuse(
      name,
      `${quoteList(missing)} required, not given.${stray} ${takes} ` +
        `Ask the user for what you don't have — never fill it with a guess.${otherTool}`,
    );
  }
  if (undeclared.length > 0 && schema.additionalProperties === false) {
    return refuse(name, `${stray.trim()} ${takes}${otherTool}`);
  }

  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || !PLACEHOLDERS.has(value.trim().toLowerCase())) continue;
    if (namesValue(properties[key], value)) continue;
    return refuse(
      name,
      `"${key}" is "${value}" — a placeholder, not a value. ` +
        "Ask the user for it, or use a different identifier you already have.",
    );
  }
  return undefined;
}

/**
 * For a call that FAILED: the note naming each required string it sent empty,
 * or `undefined`. See this module's doc for why this is not a refusal.
 *
 * @internal
 */
export function emptyArgsNote(
  args: Readonly<Record<string, unknown>>,
  schema: JSONSchema7 | undefined,
): string | undefined {
  const empty = (schema?.required ?? []).filter(
    (key) => typeof args[key] === "string" && (args[key] as string).trim() === "",
  );
  if (empty.length === 0) return undefined;
  return (
    `${quoteList(empty)} ${empty.length === 1 ? "was" : "were"} sent empty, so nothing could ` +
    "match. Ask the user for the value rather than retrying without it."
  );
}

/**
 * Worded like the executor's own schema refusal, so the model sees one shape,
 * and closing like every refusal does: whether the identical call would run.
 */
function refuse(name: string, detail: string): string {
  return serializeToolFailure(
    `Invalid arguments for tool "${name}" (not sent): ${detail} ` +
      "The same arguments will be refused again.",
    INVALID_ARGUMENTS,
  );
}

/** Whether a parameter's own `enum` or `const` lists `value` — then it is an answer. */
function namesValue(property: JSONSchema7Definition | undefined, value: string): boolean {
  if (!isRecord(property)) return false;
  const schema = property as JSONSchema7;
  return schema.const === value || (schema.enum ?? []).includes(value);
}

function quoteList(keys: readonly string[]): string {
  return keys.map((key) => `"${key}"`).join(", ");
}
