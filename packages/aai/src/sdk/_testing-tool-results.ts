// Copyright 2026 the AAI authors. MIT license.
/**
 * Unwrapping what a tool answered, for a spec that ran one.
 *
 * A tool answers its own value or a `ToolFailure`; a `dialog()` tool wraps the
 * value in a {@link DialogToolResult} — the author's own value under `result`,
 * in the position the dialog reached. The DIRECT call (`runTool(theTool, …)`,
 * `theTool.execute(…)`) keeps the tool's type; the lookup by NAME answers
 * `unknown`, because tool discovery is a build step and there is no tool map at
 * the type level to recover the author's `R` from.
 *
 * Every spec wrote the same lines — check for a refusal, throw naming it, reach
 * through `.result` for a dialog tool — and a template may not import from
 * outside its own directory, which is why this is on `@alexkroman1/aai/testing`.
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
 * What a tool answered, minus the refusal — or a throw quoting the refusal.
 *
 * Takes ANY tool's result. A `dialog()` tool's envelope ({@link DialogToolResult})
 * is unwrapped to the author's own value under `result`; a plain `tool()`'s
 * value comes back as it is. Either way a `ToolFailure` throws HERE, naming it,
 * rather than as an `undefined` read off the failure several assertions later.
 *
 * **Typed by INFERENCE**: handed a typed result — `runTool(theTool, …)`, or
 * `theTool.execute(…)` directly — it answers that type minus `ToolFailure`
 * (for a dialog tool, the type under `result`), so no type argument is needed.
 * The name form (`runTool(agent, "name", …)`, a `toolRunner`) answers
 * `unknown`, because a name is a string; there, say the type you expect —
 * `expectToolOk<Order>(…)` — which is unchecked at runtime, like any claim about
 * a value crossing an `unknown` boundary.
 *
 * Use {@link expectDialogOk} to keep WHERE a dialog landed, and
 * {@link expectDialogRefused} when the refusal is the subject.
 *
 * @typeParam R - What was handed in, inferred — never written. The CLAIMED form
 *   below takes the type a spec asserts instead.
 *
 * @param result - What a tool's `execute`, `runTool` or a `toolRunner` answered.
 *
 * @throws When the tool refused (`ToolFailure`), quoting the refusal —
 *   which for a `dialog()` tool is the sentence naming the state the
 *   conversation is actually in and what has to happen first.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { expectToolOk, runTool } from "@alexkroman1/aai/testing";
 * import { toolFailure } from "@alexkroman1/aai/utils";
 * import { z } from "zod";
 *
 * // In a spec this is `import placeOrder from "./tools/place_order.ts"`.
 * const placeOrder = tool({
 *   description: "Place the order",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: async ({ item }) => (item ? { id: "ord_1" } : toolFailure("Name an item.")),
 * });
 * const order = expectToolOk(await runTool(placeOrder, { item: "pizza" }));
 * console.log(order.id); // typed: the failure arm is subtracted
 * ```
 *
 * @public
 */
export function expectToolOk<R>(
  result: R,
): R extends DialogToolResult<infer V> ? V : Exclude<R, ToolFailure>;
/**
 * What a tool answered, minus the refusal — the CLAIMED form, for a result
 * typed `unknown` (`runTool(agent, "name", …)`, a `toolRunner`).
 *
 * `T` is what the spec says the tool answers, unchecked at runtime. Behaves as
 * the inferred form does: a dialog envelope is unwrapped, a plain value passes
 * through, a `ToolFailure` throws quoting the refusal.
 *
 * @typeParam T - The type the spec claims for the tool's own value.
 *
 * @example
 * ```ts no-check
 * import { expectToolOk, toolRunner } from "@alexkroman1/aai/testing";
 *
 * const run = toolRunner(agentDef);
 * const order = expectToolOk<{ id: string }>(await run("place_order", { item: "pizza" }));
 * ```
 *
 * @public
 */
export function expectToolOk<T>(result: unknown): T;
// The inferred signature's return is a conditional over `R`, which no runtime
// value can be checked against; the two guards below are what make it true.
export function expectToolOk(result: unknown): unknown {
  // The refusal FIRST, for the reason `expectDialogOk` gives.
  if (isToolFailure(result)) throw new Error(`tool refused: ${result.error}`);
  return isDialogEnvelope(result) ? result.result : result;
}

/**
 * Is this a dialog tool's envelope — `{ result, state, done }` as
 * {@link DialogToolResult} writes it — rather than a plain tool's own value?
 *
 * All three fields, typed: a plain tool's value passes through untouched, so
 * the only way to mistake one for an envelope is to answer this exact shape.
 */
function isDialogEnvelope(value: unknown): value is { result: unknown } {
  return (
    isRecord(value) &&
    "result" in value &&
    typeof value.state === "string" &&
    typeof value.done === "boolean"
  );
}

/**
 * The dialog envelope a gated tool answered, keeping WHERE the dialog landed.
 *
 * The half a spec needs when the assertion is about the conversation rather
 * than about the tool's own value — that a call advanced the machine into
 * `quote.pending`, that a final state reports `done`. Unlike
 * {@link expectToolOk}, which passes a plain tool's value through, this THROWS
 * on anything that is not a dialog envelope: keeping a position claims there is
 * one.
 *
 * @typeParam T - What the tool's `execute` returns, under `result`.
 *
 * @throws When the tool refused, quoting the refusal, as {@link expectToolOk} does.
 * @throws When the value is not a dialog envelope — a plain `tool()` has no
 *   position to keep; use {@link expectToolOk} for it.
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
