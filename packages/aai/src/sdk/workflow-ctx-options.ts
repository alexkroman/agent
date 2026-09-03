// Copyright 2026 the AAI authors. MIT license.
/**
 * The per-call OPTIONS a workflow body passes, and the one default it reads back.
 *
 * Split from `sdk/workflow-ctx.ts` along the seam `sdk/dialog-types.ts` and
 * `sdk/session-slot-types.ts` already use in this package — what a caller passes
 * IN, versus the handle it is given — when naming the durable waits took that
 * file past the 500-line cap. Every name here is re-exported from
 * `workflow-ctx.ts`, so an author still imports all of it from
 * `@alexkroman1/aai` and still finds it beside the method that takes it.
 *
 * ## Two of these options are a SCHEMA, and the reason is the same both times
 *
 * A durable run handles exactly two values it did not compute: a hook's payload,
 * which arrives over public HTTP, and a step's journaled output, which arrives
 * from a database written by an earlier walk — possibly by an earlier BUNDLE.
 * Both were typed by a type PARAMETER and checked by nothing, which is the shape
 * `sdk/step-generate-json.ts` argues against under "Why a schema rather than a
 * type parameter": a value the compiler believes and nothing verified flows into
 * the body's own logic as if it had obeyed.
 *
 * The schema is a [Standard Schema](https://standardschema.dev) — zod by
 * convention, and nothing here imports it. Validation IS the contract (a
 * `~standard.validate` call); only JSON Schema CONVERSION needs a vendor path,
 * and none of this converts. So the type comes from `sdk/standard-schema.ts`,
 * which is zod-free, and a `workflows/*.ts` module bundled with an agent pays
 * nothing for the option existing.
 *
 * **The two are typed DIFFERENTLY, and that is a decision rather than an
 * oversight.** {@link WaitForOptions.schema} REPLACES the wait's type parameter,
 * because a payload has no other source of truth — the type parameter was always
 * a claim about a stranger's JSON. {@link StepOptions.schema} does not: a step's
 * body already produces a typed value, so the schema's job is to say that the
 * value really has that shape before it is journaled, and the OVERLOAD it selects
 * hands the schema's output back for the same reason the wait's does — the
 * journal is what the next walk reads, and what it holds is what the schema
 * passed.
 *
 * @module
 */

import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * Per-step overrides. Everything here has a default that is right for most
 * steps; passing nothing is the common case.
 *
 * @typeParam S - The schema {@link StepOptions.schema} carries, when one is
 *   given. Defaulted, so `StepOptions` is still spellable without an argument —
 *   every caller that predates the schema still means what it meant.
 * @public
 */
export type StepOptions<S extends StandardSchemaV1 = StandardSchemaV1> = {
  /**
   * How many times to run this step before the run fails, counting the first
   * attempt.
   *
   * Only a `RetryableError` (or an unclassified throw) consumes an attempt — a
   * `FatalError` fails the run on the spot, which is the point of the
   * distinction. See `@alexkroman1/aai/step-errors`.
   *
   * Defaults to {@link DEFAULT_STEP_MAX_ATTEMPTS}. It is a per-step number
   * rather than a global because the right answer is a property of what the
   * step DOES: a model call worth retrying three times and a payment capture
   * worth retrying never are both ordinary.
   */
  maxAttempts?: number;
  /**
   * The shape this step's output must have — any
   * [Standard Schema](https://standardschema.dev), zod being the documented
   * default. Its OUTPUT type is what the step resolves to.
   *
   * **Checked on BOTH sides of the journal, and the two catch different bugs.**
   * On the WRITE, before the entry is appended, so a body that produced the
   * wrong shape — or a value the journal's codec cannot carry — fails at the
   * step that produced it rather than on a replay days later; that failure is
   * the step's own, so it spends an attempt and a retry may well fix it. On the
   * READ, when a later walk is answered from the journal, which is what catches
   * a REDEPLOY mid-flight: the run resumes against a bundle whose step returns a
   * different shape, and without this the body is handed the old one under the
   * new type. That failure is NOT the step's — the step succeeded, days ago —
   * so it fails the run the way a divergence does and journals nothing.
   *
   * Durable session state has been checked structurally in both backends for a
   * long time (`packages/aai/CLAUDE.md`, "A slot OWNS its session state": `Map`
   * → `{}`, `Date` → string, `NaN` → null — the values that corrupt do not
   * throw, so `JSON.stringify` is not the check). A step's output is exactly as
   * durable and had no check at all.
   *
   * A schema that COERCES is supported and often the better answer: what is
   * journaled is what the schema passed, never the raw value, so the next walk
   * reads the same thing this one was handed.
   */
  schema?: S | undefined;
};

/**
 * {@link StepOptions} with the schema PRESENT — what selects the validating
 * overload of `ctx.step`, whose result is the schema's output rather than
 * whatever the body happened to return.
 *
 * @public
 */
export type StepSchemaOptions<S extends StandardSchemaV1 = StandardSchemaV1> = StepOptions<S> & {
  /** The shape — see {@link StepOptions.schema}. */
  schema: S;
};

/**
 * Attempts a step gets when {@link StepOptions.maxAttempts} says nothing.
 *
 * Three, which is what the DevKit's queue hardcoded — kept deliberately so the
 * migration changes no retry behaviour it does not have to. Note attempts ARE
 * burned by failed boots, so a step can reach its ceiling without ever having
 * run its body; that was true before this change and is unchanged by it.
 *
 * @public
 */
export const DEFAULT_STEP_MAX_ATTEMPTS = 3;

/**
 * Per-wait options, for a wait that carries a DEADLINE.
 *
 * A wait that carries only a schema takes {@link WaitForSchemaOptions} instead —
 * two types rather than one optional `timeoutMs`, because the deadline is what
 * decides whether the call can resolve `undefined`, and a single bag with both
 * halves optional would put `| undefined` on the result of a wait that has no
 * way to end unanswered.
 *
 * @public
 */
export type WaitForOptions<S extends StandardSchemaV1 = StandardSchemaV1> = {
  /**
   * How long to wait before giving up, in milliseconds.
   *
   * Resolves `undefined` when it elapses unanswered — not a throw, because a
   * window closing is an ordinary outcome a body branches on rather than a
   * failure. A signal that arrives after it is answered `false`, so a caller
   * cannot be told their answer was taken when it was not.
   */
  timeoutMs: number;
  /**
   * The shape the payload must have — any
   * [Standard Schema](https://standardschema.dev), zod being the documented
   * default. Its OUTPUT type is what the wait resolves to, in place of the type
   * parameter.
   *
   * **A payload is UNTRUSTED**: it arrives over public HTTP, through
   * `ctx.workflows.signal` or a webhook delivery to
   * `ctx.workflows.publicWebhookUrl(token)`, and nothing between the sender and
   * the body inspects it. The type parameter says what you EXPECT; this is the
   * only thing that checks. `stepGenerateJson` on `@alexkroman1/aai/step` makes
   * the same trade against a model's reply, and its module doc carries the
   * general argument under "Why a schema rather than a type parameter".
   *
   * A payload that fails is a FATAL failure of the run rather than a retry or an
   * `undefined`: the payload is journaled, so every later delivery reads the
   * same bytes and refuses identically — there is nothing a redelivery could
   * change.
   *
   * **Validation runs AFTER the window has been decided, and does not un-decide
   * it.** Whether this wait was answered or timed out is settled by a
   * compare-and-set on the hook before the body continues (`closeHook`) — that
   * ordering is what stops a signal landing a moment later from making the next
   * replay answer a window this one timed out — so by the time a payload is
   * checked, the delivery has already happened and been recorded. A rejected
   * payload therefore leaves the hook exactly as it found it: DELIVERED, not
   * reopened. Reopening would be worse in both directions — it would invite a
   * second signal to overwrite the first, and it would make the run's history
   * disagree with the request the sender was answered on. Nobody sent the wrong
   * shape twice by accident, and the run failing loudly is the outcome that gets
   * it fixed.
   *
   * `timeoutMs` elapsing unanswered is NOT a validation failure: there is no
   * payload, the wait resolves `undefined`, and the schema is never consulted.
   *
   * A schema that coerces or strips unknown keys is supported and is usually
   * what a webhook wants; the validated value is what the body receives.
   *
   * ```ts
   * import type { WorkflowCtx } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * // Derived from the run's own input, so the tool handing the URL out and the
   * // body waiting on it agree — see `WorkflowCtx.waitFor`.
   * declare function approvalToken(id: string): string;
   *
   * export async function reviewFlow(input: { id: string }, ctx: WorkflowCtx) {
   *   const approval = await ctx.waitFor(approvalToken(input.id), {
   *     schema: z.object({ approved: z.boolean() }),
   *     timeoutMs: 24 * 60 * 60 * 1000,
   *   });
   *   if (approval === undefined) return { published: false, reason: "expired" };
   *   return { published: approval.approved };
   * }
   * ```
   */
  schema?: S | undefined;
};

/**
 * A wait that carries a schema and NO deadline — `ctx.waitFor(token, { schema })`.
 *
 * Its own type rather than an optional `timeoutMs` on {@link WaitForOptions},
 * for the reason stated there: an unbounded wait has no unanswered branch, so
 * its result must not carry `| undefined`.
 *
 * @public
 */
export type WaitForSchemaOptions<S extends StandardSchemaV1 = StandardSchemaV1> = {
  /** The shape the payload must have — see {@link WaitForOptions.schema}. */
  schema: S;
};

/**
 * Per-sleep options.
 *
 * @public
 */
export type SleepOptions = {
  /**
   * A name for this wait, so it can be ended early by name.
   *
   * Not required, and the default is deliberately the broad one: a `wake` naming
   * no ids ends every outstanding wait on the run. An id is what lets a run with
   * two concurrent waits — a review window and a retry backoff — have one of them
   * cut short without the other.
   */
  correlationId?: string;
};
