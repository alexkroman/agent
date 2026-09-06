// Copyright 2026 the AAI authors. MIT license.
/**
 * Unwrapping what a tool answered, for a spec that ran one by name.
 *
 * A `dialog()` tool answers a {@link DialogToolResult} — the author's own value
 * under `result`, wrapped in the position the dialog reached — or a
 * `ToolFailure` when the call was refused out of state. Both are
 * legitimate answers, so `runTool` and `toolOf(...).execute(...)` are typed
 * `unknown`: the registry lookup is by STRING, and tool discovery is a build
 * step, so there is no tool map at the type level to recover the author's `R`
 * from. (The DIRECT call — `myTool.execute(args, ctx)` — keeps its type; this
 * is only for the lookup path.)
 *
 * So every spec driving a gated tool wrote the same three lines: check for a
 * refusal, throw naming it, reach through `.result`. Four template specs had
 * them byte-identical, and a template may not import from outside its own
 * directory — which is why this is on `@alexkroman1/aai/testing` rather than in
 * a shared file next to them.
 *
 * **Failing HERE, naming the refusal, is the whole value.** The alternative is a
 * cast: `(result as { result: Order }).result`, which on a refused call reads
 * `undefined` off the failure object and fails several assertions later on a
 * property of `undefined` — with the sentence the dialog wrote about what has to
 * happen first thrown away.
 *
 * @module _testing-tool-results
 */

import { z } from "zod";
import { dialogRefusalPattern } from "./_dialog-refusal.ts";
import type { DialogToolResult } from "./dialog.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { isToolFailure, type ToolFailure } from "./utils.ts";

/**
 * The value a gated tool's own `execute` returned, or a throw naming the refusal.
 *
 * @typeParam T - What the tool's `execute` returns. Unchecked at runtime, like
 *   any assertion about a value crossing a `unknown` boundary — this recovers
 *   the type the lookup path cannot, it does not validate it.
 *
 * @param result - What `runTool` / `toolOf(...).execute(...)` answered.
 *
 * @throws When the tool refused (`ToolFailure`), quoting the refusal —
 *   which for a `dialog()` tool is the sentence naming the state the
 *   conversation is actually in and what has to happen first.
 * @throws When the value is not a tool result envelope at all, which is what a
 *   plain `tool()` answers: use its return value directly, there is nothing to
 *   unwrap.
 *
 * @example
 * ```ts no-check
 * // `no-check`: the agent under test is in another file, which is the point.
 * import { expectToolOk, runTool } from "@alexkroman1/aai/testing";
 *
 * const order = expectToolOk<{ id: string }>(
 *   await runTool(agentDef, "place_order", {}, ctx),
 * );
 * expect(order.id).toBe("ord_1");
 * ```
 *
 * @public
 */
export function expectToolOk<T>(result: unknown): T {
  return expectDialogOk<T>(result).result;
}

/**
 * The same unwrap as {@link expectToolOk}, keeping WHERE the dialog landed.
 *
 * The half a spec needs when the assertion is about the conversation rather
 * than about the tool's own value — that a call advanced the machine into
 * `quote.pending`, that a final state reports `done`. `expectToolOk()` is this
 * with `.result` taken off the end.
 *
 * @typeParam T - What the tool's `execute` returns, under `result`.
 *
 * @throws As {@link expectToolOk} does, and for the same reasons.
 *
 * @example
 * ```ts no-check
 * import { expectDialogOk, runTool } from "@alexkroman1/aai/testing";
 *
 * const answered = expectDialogOk<{ quoted: number }>(
 *   await runTool(agentDef, "quote", {}, ctx),
 * );
 * expect(answered.state).toBe("quote.pending");
 * expect(answered.result.quoted).toBe(42);
 * ```
 *
 * @public
 */
export function expectDialogOk<T>(result: unknown): DialogToolResult<T> {
  // The refusal FIRST, because it is the case worth reporting well: a
  // `ToolFailure` is a record without `result`, so the envelope check below
  // would otherwise report it as "not a tool result" and throw away the
  // sentence the dialog wrote.
  if (isToolFailure(result)) throw new Error(`tool refused: ${result.error}`);
  if (!(isRecord(result) && "result" in result && "state" in result)) {
    throw new Error(
      `Expected a dialog tool result ({ result, state, done }) and got ${describeValue(result)}. ` +
        "A plain tool() answers with its own return value, which needs no unwrapping; " +
        "only a dialog() tool wraps one.",
    );
  }
  // Rebuilt rather than cast: `Record<string, unknown>` and
  // `DialogToolResult<T>` do not overlap enough for a direct assertion, and the
  // one spelling that would silence it is the double cast this repo counts as
  // debt. Rebuilding also normalizes the three envelope fields, which
  // is what lets a spec assert on `done` without checking its type first.
  const { result: value, state, done, instruction } = result;
  return {
    result: value as T,
    state: String(state),
    done: done === true,
    ...omitUndefined({ instruction: typeof instruction === "string" ? instruction : undefined }),
  };
}

/**
 * The refusal a gated tool answered with, or a throw saying the gate did NOT hold.
 *
 * The mirror of {@link expectDialogOk}, for the spec whose subject is that a
 * tool was REFUSED: called before the dialog reached its state, or after it
 * left. Six template specs had written the other half by hand — an
 * `isToolFailure` check, a `toBe(true)`, and a regex for the sentence the gate
 * writes — and a success slipped through that shape as three assertions that
 * never ran, because each sat inside the `if` the guard opened.
 *
 * With a `state`, the refusal must also NAME it: that the tool was refused is
 * half the claim, and that the conversation was where the spec thinks it was is
 * the half a gate on the wrong state hides in. Matched with
 * {@link dialogRefusalPattern}, so a spec never spells the sentence.
 *
 * @param result - What `runTool` / `toolOf(...).execute(...)` answered.
 * @param state - The position the refusal must name, as `DialogPosition.state`
 *   spells it. Omit to accept a refusal at any state.
 *
 * @throws When the tool was NOT refused — a dialog envelope is reported with the
 *   state it landed in, since that is the fact the spec got wrong.
 * @throws When it was refused for some other reason, or at some other state,
 *   quoting the refusal.
 *
 * @example
 * ```ts
 * import { expectDialogRefused } from "@alexkroman1/aai/testing";
 *
 * const refused = expectDialogRefused(
 *   { error: 'Not available yet: this conversation is at "idle". Call start_plan first.' },
 *   "idle",
 * );
 * refused.error.includes("start_plan"); // true — the instruction the model recovers from
 * ```
 *
 * @public
 */
export function expectDialogRefused(result: unknown, state?: string): ToolFailure {
  if (!isToolFailure(result)) {
    const landed =
      isRecord(result) && "state" in result ? ` — the dialog is at "${String(result.state)}"` : "";
    throw new Error(
      `Expected the dialog to refuse this call and it answered ${describeValue(result)}${landed}.`,
    );
  }
  if (!dialogRefusalPattern(state).test(result.error)) {
    const where = state === undefined ? "" : ` at "${state}"`;
    throw new Error(`Expected a dialog refusal${where} and got: ${result.error}`);
  }
  return result;
}

/** What was there instead, short enough for a message and never a whole object dump. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (isRecord(value)) return `an object with keys: ${Object.keys(value).join(", ") || "(none)"}`;
  return typeof value;
}

/**
 * The envelope a gated tool answers with, as a schema around the tool's own.
 *
 * {@link expectDialogOk} unwraps a value a spec HOLDS. An eval holds the
 * serialized copy the model was handed and reads it back through a schema —
 * `toolResultIn(turn.toolCalls, "set_stay", schema)` — so it needs the same
 * envelope as a schema rather than as a function, and three shipped evals had
 * each written it out: `z.object({ result, state: z.string(), done:
 * z.boolean() })`, under a comment saying the shape was the SDK's. It is, and
 * this is where it lives: `result` is whatever the author's `execute` returned,
 * `state` is where the call landed, `done` whether that state is final, and
 * `instruction` is the state's own brief when it declares one — the fields of
 * {@link DialogToolResult}, which a `dialog.tool` writes and no tool file does.
 *
 * Parsing rather than casting is what makes a template that stopped carrying its
 * position fail naming the field, instead of a later `expect` reading
 * `undefined.state`.
 *
 * @typeParam T - The schema of the tool's OWN result, under `result`.
 *
 * @param result - What the tool's `execute` answers with.
 *
 * @example
 * ```ts
 * import { dialogResultSchema } from "@alexkroman1/aai/testing";
 * import { z } from "zod";
 *
 * // In an eval: `toolResultIn(turn.toolCalls, "set_stay", Stay)`. Holding the
 * // serialized result yourself, it is the same parse:
 * const Stay = dialogResultSchema(z.object({ options: z.string() }));
 * const stay = Stay.parse(
 *   JSON.parse('{"result":{"options":"garden view"},"state":"booking.room","done":false}'),
 * );
 * stay.state; // "booking.room"
 * stay.result.options; // "garden view"
 * ```
 *
 * @public
 */
export function dialogResultSchema<T extends z.ZodType>(result: T) {
  return z.object({
    result,
    state: z.string(),
    done: z.boolean(),
    instruction: z.string().optional(),
  });
}
