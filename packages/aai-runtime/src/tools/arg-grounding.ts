// Copyright 2026 the AAI authors. MIT license.
/**
 * A WRITE naming an identifier no record has shown is refused once, with the
 * values the records do hold for that field.
 *
 * ## Why
 *
 * LedgerAgent (Uddin et al., arXiv 2606.20529) gates every write on
 * predicates over what read tools returned; of its five kinds, ARGUMENT
 * GROUNDING is the one that needs no domain knowledge — "an exchange item and
 * replacement variant appear in observed records", "a selected flight came
 * from a prior search". Its other kinds (ownership, state preconditions,
 * payment provenance) are an author's policy, not an SDK default.
 *
 * ## What is checked
 *
 * Only a tool declared a write (`annotations.readOnlyHint: false`), and only
 * its IDENTIFIER arguments: a key named like `order_id`, `item_ids` or
 * `flight_number` (at any nesting, an array's strings under its key) whose
 * value has a digit and no spaces — so a dictated address, a date or a free-text
 * reason is never checked. Such a value must appear, as a whole token, in some
 * SUCCESSFUL tool result of this conversation; a failure is not evidence (one
 * echoes the bad value back, this refusal included).
 *
 * ## Once, not always
 *
 * Like `format-mirror.ts`: the identical call sent again after this refusal
 * runs. A caller may read out a valid identifier no lookup returned, and the
 * records are evidence, not the tool's contract. The history is the memory —
 * the refusal is a tool message — so nothing is held here.
 *
 * @module
 */

import type { Message } from "@alexkroman1/aai";
import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import { isFailedToolResult } from "../_prepare-step.ts";

/** The refusal's `reason` — open-ended in `ToolRefusalReason`, so no type change. */
export const UNGROUNDED_ARGUMENT_REASON = "ungrounded_argument";

/** `id`, `order_id`, `item_ids`, `flight_number`. */
const ID_KEY = /(?:^|_)ids?$|_number$/i;
/** An identifier's shape: 3+ characters of `#`, letters, digits and `_`, one a digit. */
const ID_VALUE = /^(?=.*\d)[#A-Za-z0-9_]{3,}$/;
/** How many of the records' own values a refusal names. */
const MAX_EXAMPLES = 5;

/**
 * The refusal for a write's `args`, or `undefined` to let it run. `history`
 * is the call's history snapshot.
 *
 * @internal
 */
export function groundingRefusal(
  name: string,
  args: Readonly<Record<string, unknown>>,
  history: readonly Message[],
  writes: ReadonlySet<string>,
): string | undefined {
  if (!writes.has(name)) return undefined;
  const results: string[] = [];
  const priorRefusals = new Set<string>();
  for (const message of history) {
    if (message.role !== "tool") continue;
    if (!isFailedToolResult(message.content)) results.push(message.content);
    else if (message.content.includes(UNGROUNDED_ARGUMENT_REASON)) {
      priorRefusals.add(message.content);
    }
  }
  for (const { key, value } of identifierArgs(args)) {
    if (results.some((result) => containsToken(result, value))) continue;
    const refusal = serializeToolFailure(
      refusalText(name, key, value, results),
      UNGROUNDED_ARGUMENT_REASON,
    );
    if (priorRefusals.has(refusal)) continue;
    return refusal;
  }
  return undefined;
}

function refusalText(name: string, key: string, value: string, results: readonly string[]): string {
  const field = key.replace(/s$/, "");
  const examples = recordValues(results, fieldNames(key, field));
  const held =
    examples.length === 0
      ? "No record you have looked up holds a value for it."
      : `The records hold ${JSON.stringify(field)} values like ${examples.map((v) => JSON.stringify(v)).join(", ")}.`;
  return (
    `Not sent: ${name} had "${key}" as ${JSON.stringify(value)}, which no record you have ` +
    `looked up this call contains — a change may only name what a lookup returned. ${held} ` +
    "Look the record up, or check the value with the caller. If it is right as it is, send " +
    "the identical call again and it will run."
  );
}

/**
 * The record fields an argument's values live under: its own key, singular,
 * and the singular with leading words dropped — `new_item_ids` is filled from
 * records' `item_id`. Never down to one word (`id` would match every record).
 */
function fieldNames(key: string, field: string): Set<string> {
  const names = new Set([key, field]);
  const words = field.split("_");
  for (let i = 1; i < words.length - 1; i++) names.add(words.slice(i).join("_"));
  return names;
}

/** Every identifier argument — see the module doc. */
function identifierArgs(args: unknown, key = ""): { key: string; value: string }[] {
  if (typeof args === "string") {
    return ID_KEY.test(key) && ID_VALUE.test(args) ? [{ key, value: args }] : [];
  }
  if (Array.isArray(args)) return args.flatMap((item) => identifierArgs(item, key));
  if (!isRecord(args)) return [];
  return Object.entries(args).flatMap(([k, v]) => identifierArgs(v, k));
}

/** Does `text` hold `value` with no identifier character on either side? */
function containsToken(text: string, value: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(value, from);
    if (at < 0) return false;
    const before = text[at - 1];
    const after = text[at + value.length];
    if (!(isIdChar(before, true) || isIdChar(after, false))) return true;
    from = at + 1;
  }
}

function isIdChar(char: string | undefined, before: boolean): boolean {
  if (char === undefined) return false;
  return /[A-Za-z0-9_]/.test(char) || (before && char === "#");
}

/** Up to {@link MAX_EXAMPLES} distinct string values the records hold under `keys`. */
function recordValues(results: readonly string[], keys: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const result of results) collectValues(safeJsonParse(result), keys, found);
  return [...found].slice(0, MAX_EXAMPLES);
}

function collectValues(value: unknown, keys: ReadonlySet<string>, found: Set<string>): void {
  if (found.size >= MAX_EXAMPLES) return;
  if (Array.isArray(value)) {
    for (const item of value) collectValues(item, keys, found);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string" && keys.has(key)) found.add(field);
    else collectValues(field, keys, found);
  }
}
