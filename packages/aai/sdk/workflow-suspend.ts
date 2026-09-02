// Copyright 2026 the AAI authors. MIT license.
/**
 * How a body recognises the engine asking it to STOP.
 *
 * `ctx.sleep` and `ctx.waitFor` suspend by THROWING — a wait may be days long and
 * the stack has to unwind from whatever depth the call was made at, and there is
 * no way to signal "come back later" up through code that is not expecting it.
 *
 * The consequence is the thing this module exists for: **JavaScript `catch`
 * catches everything, so an ordinary `try`/`catch` around a wait catches the
 * suspend.** A body that then does cleanup and swallows the throw has performed
 * its cleanup against a run that was merely waiting.
 *
 * That is not hypothetical. It shipped: `recap-workflow`'s saga wrapped its whole
 * body in a `try`/`catch` that unwound the compensation stack, so the first poll
 * that had to wait DELETED the transcript the run was waiting for, journaled the
 * deletion as successful, and re-threw — and the engine, seeing its own signal
 * come back out, recorded the run as healthily suspended. The data was gone and
 * every signal said fine.
 *
 * ## Two defences, and a body needs both
 *
 * - **{@link isWorkflowSuspend}** is what a body's `catch` tests, so a wait can
 *   sit inside a `try` at all. Re-throw it before doing anything else.
 * - **The engine also checks.** If a suspend was thrown during a walk and the
 *   body did not propagate it, the run FAILS naming this rule rather than
 *   recording an outcome that is not true. A guard nobody has to remember is
 *   worth more than a rule everybody is told, and this one cannot be enforced at
 *   build time — whether a `catch` re-throws is a runtime property.
 *
 * @module workflow-suspend
 */

import { isRecord } from "./is-record.ts";

/**
 * The brand the engine stamps on its suspend signal.
 *
 * `Symbol.for`, so the SDK's predicate and the engine's constructor agree across
 * however many copies of either module a guest bundle holds — the same reason
 * `step-error-classes.ts` brands its two classes rather than relying on
 * `instanceof`.
 *
 * @internal Exported for `@alexkroman1/aai-runtime`, which is the only thing that
 * may SET it. A body only ever asks.
 */
export const WORKFLOW_SUSPEND_BRAND: unique symbol = Symbol.for("aai.workflowSuspend");

/**
 * Is this the engine asking the body to stop, rather than something failing?
 *
 * **A `catch` inside a workflow body must ask this first and re-throw.** The wait
 * has not failed — the run is suspended, and the engine will deliver it again.
 *
 * ```ts no-check
 * try {
 *   const job = await ctx.step("submit", () => submit(input.url));
 *   undo.push(() => ctx.step("discard", () => discard(job.id)));
 *   await ctx.sleep(60_000);
 *   return await ctx.step("collect", () => collect(job.id));
 * } catch (err) {
 *   // Not a failure: the run is waiting, and everything above it still stands.
 *   if (isWorkflowSuspend(err)) throw err;
 *   await unwind(undo);
 *   throw err;
 * }
 * ```
 *
 * A body with no `try` around its waits never needs this. Reach for it only where
 * cleanup runs on the failure path — which is exactly where swallowing a suspend
 * does damage.
 *
 * @public
 */
export function isWorkflowSuspend(value: unknown): boolean {
  // `Reflect.get` over the `isRecord` narrowing rather than a cast through it, for
  // the reason `guard-invariants` rule 17's remedy gives: a cast asserts the thing
  // the check was supposed to establish. The VALUE is compared too, so a property
  // carrying anything else cannot pass — `Symbol.for` is a registry any code in
  // the process can mint from.
  return isRecord(value) && Reflect.get(value, WORKFLOW_SUSPEND_BRAND) === true;
}
