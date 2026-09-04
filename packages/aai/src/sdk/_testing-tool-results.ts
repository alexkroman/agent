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

import type { DialogToolResult } from "./dialog.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { isToolFailure } from "./utils.ts";

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

/** What was there instead, short enough for a message and never a whole object dump. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (isRecord(value)) return `an object with keys: ${Object.keys(value).join(", ") || "(none)"}`;
  return typeof value;
}
