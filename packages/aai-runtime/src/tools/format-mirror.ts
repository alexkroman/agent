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
 * and the field is left alone.
 *
 * **And the argument must be the SAME KIND of value written another way**,
 * because field names are matched across every tool and nesting level, and one
 * `{"status": "OK"}` is enough to qualify `status`: a capitals field refuses
 * only a capitalized name (`"New York"`, `"United States"` — never
 * `"delivered"`), a digits field only a digit string of another length
 * (`"984"` — never `"99.50"`), a `#W` field only its digits with a part
 * missing (`"W123"`, `"123"`). Simulated over 6,799 tool calls in every tau2
 * run, the shape rule alone fired 18 times, every one on a malformed argument
 * (a full state name, `"United States"` for a `USA` field, a truncated item id
 * `"984"`, `"?"`), and never on a call that was right; this narrowing keeps
 * all of them but the `"?"`, which `arg-precheck.ts` answers first.
 *
 * ## Once, not always
 *
 * A model that re-sends the identical value after this refusal gets it through:
 * the records' form is evidence about the field, not the author's schema, and a
 * tool may well accept both. The refusal is remembered by the session's
 * {@link FormatMirror} (so a sibling call in the same step, or a later turn's
 * view that dropped it, is not refused twice) and recognized in the history too
 * (so a mirror built per turn still honours one an earlier turn made).
 *
 * ## Observed incrementally, and from the WHOLE result
 *
 * A history message is parsed once per mirror, not on every call. And a result
 * the call core settles is observed in full, before `toolResultMessage` caps it
 * at `MAX_TOOL_RESULT_CHARS`: a capped record is no longer JSON, and the largest
 * records (a profile, an order list) are exactly the ones this exists for.
 */

import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";

/** The refusal's `reason` — open-ended in `ToolRefusalReason`, so no type change. */
export const FORMAT_MISMATCH_REASON = "format_mismatch";

type Shape = {
  /** Unique per shape, so it is also the shape's identity. */
  describe: string;
  /** Is `value` this kind of value, written in another form? See the module doc. */
  misshapen: (value: string) => boolean;
};

/** A capitalized name — "New York", "United States", "Colorado". */
const CAPITALIZED_NAME = /^[A-Z][a-z]+(?:[ .'-]+[A-Za-z][a-z]*)*$/;

function shapeOf(value: string): Shape | undefined {
  if (/^[A-Z]{2,3}$/.test(value)) {
    return {
      describe: `${value.length} capital letters`,
      misshapen: (arg) => CAPITALIZED_NAME.test(arg),
    };
  }
  if (/^\d+$/.test(value)) {
    return {
      describe: `${value.length} digits`,
      misshapen: (arg) => /^\d+$/.test(arg),
    };
  }
  if (/^#W\d+$/.test(value)) {
    return { describe: '"#W" and digits', misshapen: (arg) => /^#?W?\d+$/.test(arg) };
  }
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
    if (shape === undefined || (prior !== undefined && prior.shape.describe !== shape.describe)) {
      seen.set(key, null);
    } else if (prior === undefined) {
      seen.set(key, { shape, example: field });
    }
  }
}

type HistoryMessage = { role: string; content?: unknown };

/**
 * See this module's doc. One per conversation; not safe to share across
 * sessions. A snapshot sharing NO message with what was read before is a new
 * conversation (a reset), and everything observed is dropped. Not a shorter
 * one: retention trims a long session's history from the front, and treating
 * that as a reset re-parsed the whole window and forgot every refusal.
 *
 * @internal
 */
export class FormatMirror {
  #seen: Seen = new Map();
  /** Refusals already answered — by this mirror, or found in the history. */
  readonly #refused = new Set<string>();
  /** History messages already read, so each is parsed once — and a reset is recognized. */
  #read = new WeakSet<object>();
  #readAny = false;

  /**
   * The refusal for `args`, or `undefined` to let the call run. `history` is
   * the call's history snapshot.
   */
  refuse(
    name: string,
    args: Readonly<Record<string, unknown>>,
    history: readonly HistoryMessage[],
  ): string | undefined {
    this.#readHistory(history);
    for (const [key, value] of Object.entries(args)) {
      if (typeof value !== "string") continue;
      const field = this.#seen.get(key);
      if (field === undefined || field === null) continue;
      if (shapeOf(value)?.describe === field.shape.describe || !field.shape.misshapen(value))
        continue;
      const refusal = serializeToolFailure(
        `Not sent: ${name} had "${key}" as ${JSON.stringify(value)}, but every record so far ` +
          `writes "${key}" like ${JSON.stringify(field.example)} (${field.shape.describe}). ` +
          "Send it in that form.",
        FORMAT_MISMATCH_REASON,
      );
      // Refused once: the same refusal already answered an earlier call.
      if (this.#refused.has(refusal)) continue;
      this.#refused.add(refusal);
      return refusal;
    }
    return undefined;
  }

  /**
   * A settled call's own result, whole — before `recorded`, the history's
   * copy, is capped. That copy is marked read, so it is not parsed again.
   */
  observeResult(result: string, recorded: object): void {
    this.#markRead(recorded);
    observe(safeJsonParse(result), this.#seen);
  }

  #markRead(message: object): void {
    this.#read.add(message);
    this.#readAny = true;
  }

  #readHistory(history: readonly HistoryMessage[]): void {
    // Empty is not a reset: a subagent's and `TextAgent.tools`' views always
    // are, and their own results (`observeResult`) are all they have.
    const fresh = !history.some((message) => this.#read.has(message));
    if (this.#readAny && history.length > 0 && fresh) {
      this.#seen = new Map();
      this.#refused.clear();
      this.#read = new WeakSet();
      this.#readAny = false;
    }
    for (const message of history) {
      if (this.#read.has(message)) continue;
      this.#markRead(message);
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      // Only refusals are kept — every result would hold the whole history.
      if (message.content.includes(FORMAT_MISMATCH_REASON)) this.#refused.add(message.content);
      observe(safeJsonParse(message.content), this.#seen);
    }
  }
}
