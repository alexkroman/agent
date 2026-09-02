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
 * **THREE layers check this now, and none is a substitute for another.** For a
 * long time nothing did — the build scan that used to try went with the DevKit,
 * having read the BUILT flow bundle on the assumption that the builder had
 * stripped step bodies out of it, so against an ordinary Vite build it warned
 * about a `Date.now()` INSIDE a step callback (legal) while blind to the
 * boundary it existed to police. What replaced it:
 *
 * - **`Literal`, at the call site.** A name that has widened to `string`
 *   is a compile error. Cheap, and it cannot reach a name whose type is a union
 *   of literals — that type's own doc carries the gap and why closing it with an
 *   `IsUnion` rejection was refused.
 * - **`guard-invariants` rule 30, before it ships.** A clock, a random number, a
 *   uuid or a `fetch` in a shipped `workflows/*.ts` is a gate failure; the
 *   legitimate case — the same read inside a step body — is baselined with its
 *   reason at the line. This is the honest lexical pass the DevKit's scan was
 *   not, and it is line-based rather than an AST walk, which is why it bans the
 *   call in the file and leaves the boundary to the baseline.
 * - **The ENGINE, at run time.** A walk that mints a journal key no earlier walk
 *   ever reached, while the journal still holds work it cannot explain, is
 *   refused rather than executed — `aai-runtime/workflow-replay-divergence.ts`,
 *   which carries the measurement (7 of 10 runs executing a side effect twice,
 *   all 10 reporting `completed`). It is the only layer that sees a name read
 *   from a config table, so it is necessary regardless of the other two.
 *
 * What NONE of them sees is a wait's identity. `ctx.sleep` and
 * {@link WorkflowCtx.waitFor} are keyed POSITIONALLY (`sleep!0`, `hook!0`), so a
 * body reaching a different NUMBER of waits reads another wait's record — and a
 * pure-sleep divergence reaches no step name for any layer to catch.
 *
 * **The one shape that GUARANTEES it is a wait inside a step, and the engine
 * refuses that outright.** A settled step's body is not re-executed, so its wait
 * stops being reached the moment the step lands and every later wait in the run
 * slides one place down the key space — measured, a week-long `ctx.sleep` after a
 * sleeping step was skipped in full and the run reported `completed`. The same
 * body also re-ran its step from the top on every delivery, side effects
 * included. A fourth layer therefore fails the run on the spot, naming the fix:
 * `aai-runtime/workflow-replay-wait.ts`. It has to be the ENGINE and not a type,
 * because the callback captures the outer `ctx` and no step-scoped parameter can
 * take a binding out of lexical scope.
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
 * failure" — describing a duplicate-literal check that has never existed and has
 * no scan left to live in. Until one does, give two call sites two names; a single
 * site in a loop or a fan-out is exactly what the scheme is for and needs none.
 * The shipped templates follow that (`research-workflow` names its two
 * `investigate` waves separately, `call-audit` its two clock reads), which is the
 * pattern to copy.
 *
 * @module
 */

/**
 * A string LITERAL — the same type, unless it has widened to `string`.
 *
 * `string extends S` is only true when `S` IS `string`, so a widened argument
 * resolves to `never` and the call site is a compile error naming the parameter.
 * That turns "make it a string LITERAL" from advice in the doc below into
 * something the checker says.
 *
 * ## What it CANNOT catch, stated because the gap is the interesting part
 *
 * Determinism is a fact about how a value was PRODUCED; a type records only what
 * shape it HAS, and `Math.random() < 0.5 ? "h" : "t"` and `config.mode` are the
 * SAME TYPE. So this rejects a widened `string` and nothing subtler:
 *
 * - `` `charge-${coin}` `` where `coin` is `"h" | "t"` infers a UNION OF
 *   LITERALS, which is not `string`, so it passes. That is the measured bug — 7
 *   of 10 runs executing a side effect twice, see
 *   `aai-runtime/workflow-replay-divergence.ts` — and it is caught at RUNTIME
 *   instead.
 * - `` `charge-${Date.now()}` `` is `` `charge-${number}` ``, also not `string`,
 *   also passes. `guard-invariants` rule 30 is the layer that sees that one, by
 *   banning the clock in a shipped body rather than by typing the name.
 *
 * An `IsUnion` rejection would catch the first case and was deliberately NOT
 * added: it false-positives on a name derived from a legitimate config union,
 * and a gate that refuses correct code is worse than the runtime check catching
 * the mistake. Three layers, none a substitute for another.
 */
type Literal<S extends string> = string extends S ? never : S;

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
   * **`fn` may not wait.** {@link WorkflowCtx.sleep} and
   * {@link WorkflowCtx.waitFor} reached inside a step fail the run, because a
   * suspend unwinds out of the step without journaling it — so the body would
   * re-run from the top on every delivery, and every later wait in the run would
   * read the wrong record. Put the wait in the body, between two steps. For a
   * plain in-step delay that is not durable, use an ordinary timer.
   *
   * `name` identifies the step in the journal and in `aai workflow` output, so
   * make it a string LITERAL. A computed one has to produce the same string on
   * every replay or the walk reads a key that was never written — and a name
   * built from the run's own data is unreadable in that run's history besides.
   * A loop needs no name of its own per round: the occurrence count is what
   * separates the iterations.
   *
   * The `Literal` constraint is what makes "a string LITERAL" a compile error
   * rather than a sentence in this paragraph. It is deliberately not exported —
   * an author meets it as the message tsc prints, never by name — so its doc,
   * carrying the two shapes it cannot reach and which layer catches each, is in
   * `sdk/workflow-ctx.ts` beside the declaration. A harness that means
   * to pass an unbounded name narrows `ctx.step` through one typed alias rather
   * than casting at each site.
   */
  step<T, const Name extends string>(
    name: Name & Literal<Name>,
    fn: () => Promise<T> | T,
    options?: StepOptions,
  ): Promise<T>;
  /**
   * Wait, durably — for a duration in milliseconds, or until an absolute `Date`.
   *
   * **This is not `setTimeout`, and the difference is the whole point.** The run
   * SUSPENDS: the body stops, the process is free, and the engine re-delivers the
   * run when the time comes — which is what makes "check back tomorrow" a thing a
   * workflow can express at all.
   *
   * **How long it really survives is a property of the JOURNAL**, which the
   * DEPLOYMENT picks and the runtime's boot line names. On the platform and
   * against a Postgres it is durable — a wait outlives the body, the worker and
   * the process, so a multi-day schedule is a thing to write. With neither the
   * journal is in memory, which is `aai dev`'s default and where a restart loses
   * every outstanding wait.
   *
   * A sleep is journaled the first time it is reached, so its wake time is
   * decided ONCE. That matters because the body is replayed: computing the
   * deadline from the clock on every replay would push it further out each time
   * and a run could sleep forever.
   *
   * **Call it from the BODY, never from inside a {@link WorkflowCtx.step}** — a
   * step body that waits fails the run, and the message names the fix.
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
