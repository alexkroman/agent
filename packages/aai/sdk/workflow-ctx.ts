// Copyright 2026 the AAI authors. MIT license.
/**
 * What a workflow BODY is handed: the journal and the clock, as two methods.
 *
 * This is the half of the authoring surface that replaced the Workflow DevKit's
 * `"use workflow"` / `"use step"` directives. Those were a compile-time
 * rewrite performed by a 921 KB WASM SWC plugin, and carrying it meant a
 * per-tenant, three-transform bundling pipeline — this image is baked once and
 * serves every tenant, so there is no `workflows/` directory in existence when
 * it is built. A `workflows/` module is now ordinary TypeScript compiled by the
 * agent bundle's own Vite pass, and durability is a method call instead of a
 * string literal.
 *
 * ## The body is REPLAYED, which is the whole reason this type exists
 *
 * A durable run survives its process. The engine achieves that by re-running the
 * body from the top on every resume and answering each {@link WorkflowCtx.step}
 * from the journal instead of executing it again. So the body is not ordinary
 * async code, and the rule is the one WDK had:
 *
 * - **Anything non-deterministic goes inside a `step`.** A clock, a random
 *   number, a uuid, a network call — read outside one, it produces a different
 *   value on every replay and the run silently diverges.
 * - **Anything inside a `step` runs at most once per successful execution** and
 *   its result is journaled.
 *
 * {@link WorkflowCtx.sleep} is the other half of the same idea and the reason a
 * replay engine is worth having at all: it SUSPENDS rather than waiting, so the
 * process is free for the duration and a wait can outlive it. A sleep's wake time
 * is journaled the first time it is reached, exactly like a step's result and for
 * exactly the same reason — a deadline recomputed from the clock on every replay
 * moves further out each time, and the run never wakes.
 *
 * **Nothing checks this yet, and that is worth knowing rather than implying.**
 * `aai-cli`'s workflow scan still reads the BUILT flow bundle and still assumes
 * the builder stripped step bodies out of it, which the engine no longer does —
 * so it now warns about a `Date.now()` INSIDE a step callback, which is legal,
 * and cannot see the boundary it was written to police. Replacing it with a
 * lexical AST pass is the remaining half of this change: code inside a
 * `ctx.step(...)` callback runs once and code outside it replays, and that
 * boundary is decidable without running anything.
 *
 * ## Step identity is `(name, occurrence)`, and neither half is optional
 *
 * The journal has to answer "have I run this one already?" across a replay, so
 * every step needs a stable key. Two obvious schemes are both wrong here:
 *
 * - **A monotonic counter** (identity = the Nth step of the run) is replay-safe
 *   but insertion-fragile: adding a step near the top of a body shifts every
 *   later ordinal, so an in-flight run resumes against a journal that has moved
 *   under it.
 * - **The name alone** cannot express a loop. `for (…) await ctx.step("tick", …)`
 *   is one call site and N journal entries.
 *
 * So the key is the name plus the count of times THAT name has been reached in
 * THIS run — `tick#0`, `tick#1`, … — which is stable under insertion elsewhere
 * and correct in a loop. The cost is a hazard the compile-time ids did not have:
 * two DIFFERENT call sites sharing a literal name alias onto one counter and read
 * each other's results.
 *
 * **Today that is a convention to remember, and nothing enforces it.** An earlier
 * draft of this doc said it was "not a convention to remember, it is a build
 * failure" — describing the duplicate-literal check the scan above is meant to
 * grow and does not have. Until it does, give two call sites two names; a single
 * site in a loop or a fan-out is exactly what the scheme is for and needs none.
 * The shipped templates follow that (`research-workflow` names its two
 * `investigate` waves separately, `call-audit` its two clock reads), which is the
 * pattern to copy.
 *
 * @module
 */

/**
 * Per-step overrides. Everything here has a default that is right for most
 * steps; passing nothing is the common case.
 *
 * @public
 */
export type StepOptions = {
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
 * The handle a workflow body receives as its second argument.
 *
 * ```ts no-check
 * // workflows/research.ts
 * export async function researchFlow(
 *   input: { topic: string },
 *   ctx: WorkflowCtx,
 * ) {
 *   const brief = await ctx.step("writeBrief", () => writeBrief(input.topic));
 *   const notes = await ctx.step("investigate", () => investigate(brief));
 *   return { topic: input.topic, notes };
 * }
 * ```
 *
 * Deliberately NOT the same object as a tool's `ToolContext`. A tool's `execute`
 * runs once, inside a live session, and may hold a database handle; a workflow
 * body is replayed and may hold nothing live at all. Sharing one type would put
 * `ctx.db` in reach of a body that re-runs it on every resume, which is the bug
 * the DevKit migration removed and which this must not reintroduce.
 *
 * @public
 */
export type WorkflowCtx = {
  /** This run's id — the same value `ctx.workflows.start()` resolved to. */
  readonly runId: string;
  /** Key the workflow is declared under in `agent({ workflows })`. */
  readonly workflow: string;
  /**
   * Run `fn` once and journal what it returns; on every later replay, return
   * the journaled value without running it again.
   *
   * `name` identifies the step in the journal and in `aai workflow` output. It
   * must be a string LITERAL — the build scan reads it statically, and a
   * computed name is both unreadable in a run's history and invisible to the
   * duplicate check.
   */
  step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;
  /**
   * Wait, durably — for a duration in milliseconds, or until an absolute `Date`.
   *
   * **This is not `setTimeout`, and the difference is the whole point.** The run
   * SUSPENDS: the body stops, the process is free, and the engine re-delivers the
   * run when the time comes — which is what makes "check back tomorrow" a thing a
   * workflow can express at all.
   *
   * **How long it really survives is a property of the JOURNAL, and today that is
   * memory.** A wait outlives the body and the worker; it does NOT yet outlive
   * the process, on any deployment. The platform and Postgres journals are the
   * remaining half of the DevKit removal, and the runtime's boot line reports
   * which store is in play. A multi-day schedule is expressible now and durable
   * when they land.
   *
   * A sleep is journaled the first time it is reached, so its wake time is
   * decided ONCE. That matters because the body is replayed: computing the
   * deadline from the clock on every replay would push it further out each time
   * and a run could sleep forever.
   *
   * ```ts no-check
   * await ctx.step("draft", () => draft(input.topic));
   * await ctx.sleep(6 * 60 * 60 * 1000, { correlationId: "review-window" });
   * await ctx.step("publish", () => publish(input.topic));
   * ```
   *
   * @param until - Milliseconds to wait, or the `Date` to wait until. A value
   *   already in the past returns immediately rather than erroring — a deadline
   *   that has passed HAS been reached, and a run resuming after a long outage
   *   meets that case legitimately.
   * @param options - `correlationId` names this wait so
   *   `ctx.workflows.wakeUp(runId, { correlationIds: [id] })` can end it early,
   *   which is how a "send it now" tool cuts a scheduled wait short. A `wakeUp`
   *   naming no ids wakes every outstanding SLEEP on the run — and deliberately
   *   not a `waitFor`'s deadline, so cutting a schedule short cannot also close
   *   an approval window.
   */
  sleep(until: number | Date, options?: SleepOptions): Promise<void>;
  /**
   * Wait for somebody OUTSIDE the run to answer, and resolve what they sent.
   *
   * Suspends like {@link WorkflowCtx.sleep} and with no deadline at all: the run
   * waits until `ctx.workflows.signal(token, payload)` is called. That is how a
   * run parks on a human approval, a review that may take a week, or anything
   * else somebody else decides.
   *
   * **The WEBHOOK route reaches this.** `ctx.workflows.publicWebhookUrl(token)`
   * mints a URL that `createServer` serves, and a delivery to it resolves the
   * wait: the route calls `WorkflowClient.signal`, which writes the payload
   * against this hook's own journal row and re-walks the body. So a
   * payment-callback flow is a supported shape.
   *
   * It was NOT, until recently, and the note here said so — the URL was served
   * by the DevKit's own hook table, which knew nothing about this wait and
   * answered `HookNotFound`. Both hops are covered now: the route→`signal` hop
   * by `server-workflow-app.test.ts`, and `signal`→resume by
   * `workflow-in-process.test.ts`.
   *
   * ```ts no-check
   * // The token is the AUTHOR's, derived so the body and the tool that hands it
   * // out agree — see below.
   * const approval = await ctx.waitFor<{ approved: boolean }>(approvalToken(input.id));
   * if (!approval.approved) return { published: false };
   * ```
   *
   * **The token must be DERIVED, not random.** Whoever hands the URL out is
   * usually a tool, and a tool cannot see the body's local variables — so a
   * random token leaves the run waiting on something nobody can name. Export one
   * function that computes the token from the run's own input and import it in
   * both places. This replaced the DevKit's `createHook()`, whose token was
   * generated body-side for exactly this reason a problem.
   *
   * **A payload is UNTRUSTED.** It arrives over public HTTP, so validate it with
   * a schema before acting on it; the type parameter is a claim about what you
   * expect, not a check.
   *
   * ## A deadline is an OPTION, never a race
   *
   * "Wait for an answer, but not forever" is the common case — Temporal's
   * `timeoutOrUserAction`, and what a retention gate or an approval window is.
   * Write it as `waitFor(token, { timeoutMs })`, which resolves `undefined` when
   * the window closes unanswered.
   *
   * **Do NOT reach for `Promise.race([ctx.waitFor(t), ctx.sleep(ms)])`.** Both
   * suspend, and a suspend unwinds the stack — so the race rejects on whichever
   * suspends first and the body stops before the other has been reached. That
   * composes under an engine whose waits are real promises and does not compose
   * here, which is why the deadline is a parameter: one call the engine can
   * journal as one decision.
   *
   * @param token - Who is being waited for. Two concurrent waits in one body
   *   must use different tokens, or a single signal resolves whichever the
   *   journal registered first and the other waits forever.
   * @param options - `timeoutMs` closes the window. Measured from the first time
   *   the wait is REACHED and journaled there, so a replay does not extend it.
   * @typeParam T - What the signaller is expected to send.
   */
  waitFor<T = unknown>(token: string): Promise<T>;
  waitFor<T = unknown>(token: string, options: WaitForOptions): Promise<T | undefined>;
};

/**
 * Per-wait options.
 *
 * @public
 */
export type WaitForOptions = {
  /**
   * How long to wait before giving up, in milliseconds.
   *
   * Resolves `undefined` when it elapses unanswered — not a throw, because a
   * window closing is an ordinary outcome a body branches on rather than a
   * failure. A signal that arrives after it is answered `false`, so a caller
   * cannot be told their answer was taken when it was not.
   */
  timeoutMs: number;
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
