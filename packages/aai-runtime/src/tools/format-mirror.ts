// Copyright 2026 the AAI authors. MIT license.
/**
 * A string argument written in a different SHAPE from every value the
 * conversation's records have shown for the same field is refused once, with
 * the records' form named.
 *
 * ## Why
 *
 * A voice agent says a value one way and must send it another: it reads a
 * state aloud as "New York" and the records store `"state": "NY"`. The spoken
 * form leaks into the argument. On tau2-bench retail, 12 of 138 address writes
 * across every run sent a full state name — while the user record already in
 * the context said `"state": "CO"` — and the task failed every time (tasks 22,
 * 42, 59, the same three recurring run after run). A prompt rule scoped to
 * speech did not stop it (full names at those decisions went 94% → 72% on an
 * offline replay), because the agent had just SAID "New York, New York" three
 * times. This refusal did: replayed at the same six decisions, the model's
 * next call used the two-letter form 17 of 24 times and a full name never.
 *
 * ## What counts as a shape
 *
 * Deliberately few and tight, so a field only qualifies when its form is
 * unambiguous: 2-3 capital letters (`NY`, `USA`), a fixed-length digit string,
 * and `#W` + digits. A field qualifies only when EVERY value seen for it in a
 * tool result has the same one of these shapes — one free-text value anywhere
 * and the field is left alone. Simulated over 6,799 tool calls in every tau2
 * run, it fired 18 times, every one on a malformed argument (a full state name,
 * `"United States"` for a `USA` field, a truncated item id `"984"`, `"?"`), and
 * never on a call that was right.
 *
 * ## Once, not always
 *
 * A model that re-sends the identical value after this refusal gets it through:
 * the records' form is evidence about the field, not the author's schema, and a
 * tool may well accept both. The earlier refusal is in the history the call
 * already carries, so this needs no state of its own.
 */

import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import { isRecord } from "@alexkroman1/aai/utils";

/** The refusal's `reason` — open-ended in `ToolRefusalReason`, so no type change. */
export const FORMAT_MISMATCH_REASON = "format_mismatch";

type Shape = { id: string; describe: string };

function shapeOf(value: string): Shape | undefined {
  if (/^[A-Z]{2,3}$/.test(value)) {
    return { id: `caps${value.length}`, describe: `${value.length} capital letters` };
  }
  if (/^\d+$/.test(value))
    return { id: `digits${value.length}`, describe: `${value.length} digits` };
  if (/^#W\d+$/.test(value)) return { id: "hash-w", describe: '"#W" and digits' };
  return undefined;
}

/** Per field name: the shape every seen value shares (with one example), or `null` once they differ. */
type Seen = Map<string, { shape: Shape; example: string } | null>;

function observe(value: unknown, seen: Seen): void {
  if (Array.isArray(value)) {
    for (const item of value) observe(item, seen);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, field] of Object.entries(value)) {
    if (typeof field !== "string") {
      observe(field, seen);
      continue;
    }
    const shape = shapeOf(field);
    const prior = seen.get(key);
    if (prior === null) continue;
    if (shape === undefined || (prior !== undefined && prior.shape.id !== shape.id)) {
      seen.set(key, null);
    } else if (prior === undefined) {
      seen.set(key, { shape, example: field });
    }
  }
}

function parsed(content: unknown): unknown {
  if (typeof content !== "string") return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * The refusal for `args`, or `undefined` to let the call run — see this
 * module's doc. `history` is the call's history snapshot.
 *
 * @internal
 */
export function formatMismatchRefusal(
  name: string,
  args: Readonly<Record<string, unknown>>,
  history: readonly { role: string; content?: unknown }[],
): string | undefined {
  const seen: Seen = new Map();
  const toolContents: string[] = [];
  for (const message of history) {
    if (message.role !== "tool") continue;
    if (typeof message.content === "string") toolContents.push(message.content);
    observe(parsed(message.content), seen);
  }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const field = seen.get(key);
    if (field === undefined || field === null) continue;
    if (shapeOf(value)?.id === field.shape.id) continue;
    const refusal = serializeToolFailure(
      `Not sent: ${name} had "${key}" as ${JSON.stringify(value)}, but every record so far ` +
        `writes "${key}" like ${JSON.stringify(field.example)} (${field.shape.describe}). ` +
        "Send it in that form.",
      FORMAT_MISMATCH_REASON,
    );
    // Refused once: the same refusal already answered an earlier call.
    if (toolContents.includes(refusal)) continue;
    return refusal;
  }
  return undefined;
}
