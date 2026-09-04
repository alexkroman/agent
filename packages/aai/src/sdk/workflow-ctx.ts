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
 *   value on every replay and the run silently diverges. The three commonest are
 *   methods here instead: see {@link WorkflowCtx.now},
 *   {@link WorkflowCtx.random} and {@link WorkflowCtx.uuid} below.
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
 * ## A suspension is not something a body can see
 *
 * There is nothing to catch and nothing to remember. A wait that has not elapsed
 * hands back a promise that **never settles**, so a `try` around it catches
 * nothing, a `finally` on it never runs, and every statement after it is simply
 * unreachable on that delivery. The engine suspends the run on a channel the
 * body holds no reference to (`aai-runtime/workflow-replay-suspend.ts`).
 *
 * This used to be a throw, and it was the one rule a body had to obey by hand:
 * a `catch` was told to test the signal and re-throw it. One shipped template
 * forgot — its saga unwound a compensation stack, deleted the transcript the run
 * was waiting for, journaled the deletion as successful, and the run reported as
 * healthily suspended. So `try`/`catch` in a body is now ordinary: it sees step
 * failures and nothing else.
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
 * A wait's identity used to be the thing NONE of them saw. `ctx.sleep` and
 * {@link WorkflowCtx.waitFor} were keyed POSITIONALLY (`sleep!0`, `hook!0`), so
 * a body reaching a different NUMBER of waits read another wait's record — and a
 * pure-sleep divergence reaches no step name for any layer to catch. **A wait is
 * keyed by NAME now**, exactly as a step is: `ctx.sleep` takes a `label` and
 * {@link WorkflowCtx.waitFor} already had a token, so the keys are
 * `sleep!<label>#<occurrence>` and `hook!<token>#<occurrence>` and a wait that
 * moves keeps its own record. What is left is stated at
 * `aai-runtime/workflow-replay-divergence.ts` rather than here: a label or token
 * that is itself non-deterministic mints a fresh key on every walk, which HANGS
 * the run instead of answering it wrongly — a worse-looking, better failure, and
 * still nothing's job to catch.
 *
 * **A wait inside a step is refused outright, and that was true before the
 * keying changed.** Two of its three reasons survive it. A suspend unwinds out
 * of the step without journaling it, so the body re-runs from the top on every
 * delivery, side effects included — measured, a one-step body ran its effect
 * twice and reported `completed`. And a wait parks on a promise that never
 * settles, so a step awaiting one holds the walk open against the very check
 * that would suspend it and the delivery never returns. (The third reason was
 * the key slide above: settling the step stops its wait being reached, which
 * shifted every later wait one place down a positional key space. Naming the
 * waits closed that one.) A fourth layer therefore fails the run on the spot,
 * naming the fix: `aai-runtime/workflow-replay-wait.ts`. It has to be the ENGINE
 * and not a type, because the callback captures the outer `ctx` and no
 * step-scoped parameter can take a binding out of lexical scope.
 *
 * ## A clock, a random number and a uuid are AFFORDANCES, not prohibitions
 *
 * The three rules above are the three mistakes, so the three are methods:
 * {@link WorkflowCtx.now}, {@link WorkflowCtx.random} and
 * {@link WorkflowCtx.uuid}. Each reads its source ONCE, journals the value, and
 * answers every later walk from the journal — which is exactly what an author
 * was already hand-rolling. Two shipped templates had written the clock half of
 * it (`transcription-workflow`'s `startClock`, `call-audit`'s two `now` reads),
 * each as an exported one-line function reached through a `ctx.step` and each
 * carrying its own paragraph explaining why. A hazard that needs the same
 * comment at every call site is a missing affordance.
 *
 * **They are keyed in their own POSITIONAL space** — `now!0`, `random!0`,
 * `uuid!0`, per kind. These three take no argument at all, so unlike
 * {@link WorkflowCtx.sleep} — which was positional and is not any more — there is
 * nothing to key a map on and nothing an author could be asked to name. `!` is
 * not producible by `${name}#${occurrence}`, so an author's own `ctx.step("now")`
 * cannot alias one, and the counters are per KIND rather than shared, so
 * inserting a `ctx.now()` shifts no `ctx.uuid()`.
 *
 * **So the positional hazard the waits shed is still theirs**: a body reaching a
 * different NUMBER of `ctx.now()` calls reads a predecessor's timestamp. It is
 * narrower than the wait version was, because these journal through `appendStep`
 * and so a reach is recorded for the divergence check rather than invisible to
 * it, and because the value they carry is a clock rather than a week-long
 * schedule or somebody's approval. Naming them is the obvious next move and is
 * deliberately not made: it would put a required literal on the three calls
 * whose whole point is that they are cheaper to reach for than the hand-rolled
 * `ctx.step("startClock", …)` they replaced.
 *
 * **And a positional key is what makes them illegal inside a
 * {@link WorkflowCtx.step}**, which the engine refuses exactly as it refuses a
 * wait there. A settled step's body is not re-executed, so a read inside one
 * stops being reached the moment the step lands and every later read of that kind
 * slides one place down the key space — a body would then get its predecessor's
 * uuid, silently. Inside a step there is nothing to fix anyway: a step's
 * internals are not replayed, only its result, so a plain `Date.now()` there is
 * already durable.
 *
 * The full argument — why no step ATTEMPT is leased, why `random()` journals one
 * float per call rather than seeding a sequence, and how the three participate in
 * divergence detection — is in
 * `aai-runtime/workflow-replay-determinism.ts`, which implements them.
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

import type { Literal } from "./_workflow-ctx-literal.ts";
import type { InferSchemaOutput, StandardSchemaV1 } from "./standard-schema.ts";
import type {
  SleepOptions,
  StepOptions,
  StepSchemaOptions,
  WaitForOptions,
  WaitForSchemaOptions,
} from "./workflow-ctx-options.ts";

// Re-exported so `workflow-ctx.ts` stays the one module an author (or a reader
// following a `{@link}`) needs for the whole authoring surface — the split is a
// file-length decision, not a change to where these names live.
export {
  DEFAULT_STEP_MAX_ATTEMPTS,
  type SleepOptions,
  type StepOptions,
  type StepSchemaOptions,
  type WaitForOptions,
  type WaitForSchemaOptions,
} from "./workflow-ctx-options.ts";

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
   * `sdk/_workflow-ctx-literal.ts` beside the declaration. A harness that means
   * to pass an unbounded name narrows `ctx.step` through one typed alias rather
   * than casting at each site.
   *
   * `options.schema` checks the output on both sides of the journal and makes
   * the schema's output what this resolves to — see {@link StepOptions.schema}
   * for what each side catches, and why a read-side failure is not the step's.
   */
  step<S extends StandardSchemaV1, const Name extends string>(
    name: Name & Literal<Name>,
    fn: () => unknown,
    options: StepSchemaOptions<S>,
  ): Promise<InferSchemaOutput<S>>;
  step<T, const Name extends string>(
    name: Name & Literal<Name>,
    fn: () => Promise<T> | T,
    options?: StepOptions,
  ): Promise<T>;
  /**
   * The wall clock, read ONCE and journaled — the same instant on every replay.
   *
   * The body is replayed from the top, so a plain `Date.now()` here answers
   * differently on every walk and every duration derived from it is a different
   * duration. This reads the clock the first time it is reached, journals the
   * number, and hands the identical number back forever after: it is the moment
   * the run really reached this line, however many times the line is walked.
   *
   * ```ts
   * import type { WorkflowCtx } from "@alexkroman1/aai";
   *
   * declare function transcribe(recording: string): Promise<string>;
   *
   * export async function timedFlow(input: { recording: string }, ctx: WorkflowCtx) {
   *   const startedAt = await ctx.now();
   *   const transcript = await ctx.step("transcribe", () => transcribe(input.recording));
   *   const finishedAt = await ctx.now();
   *   return { transcript, elapsedMs: finishedAt - startedAt };
   * }
   * ```
   *
   * **Not legal inside a {@link WorkflowCtx.step}** — the engine refuses one and
   * the message names the fix. A step's internals are not replayed, so a plain
   * `Date.now()` inside one is already durable and is what to write there.
   *
   * @returns Epoch milliseconds, as `Date.now()` answers them.
   */
  now(): Promise<number>;
  /**
   * A random float in `[0, 1)`, journaled — the same float on every replay.
   *
   * ONE draw per call, keyed by its own occurrence, so a loop is correct without
   * anything further: `random!0`, `random!1`, … each carry their own journaled
   * value. That is deliberately not a seeded SEQUENCE — a seed would make every
   * draw's value depend on how many draws came before it, so a body that reaches
   * a different NUMBER of them before a loop silently re-draws the whole tail,
   * and it would need a PRNG whose exact algorithm became part of the durable
   * contract.
   *
   * The cost is one journal row per call, which is the same trade `ctx.step` makes
   * and the reason a BULK draw belongs in a step:
   * `ctx.step("jitter", () => Array.from({ length: 1000 }, Math.random))`.
   *
   * **Not legal inside a {@link WorkflowCtx.step}**, for
   * {@link WorkflowCtx.now}'s reason.
   */
  random(): Promise<number>;
  /**
   * A fresh UUID, journaled — the same string on every replay.
   *
   * What an idempotency key for a downstream API wants: minted once, and still
   * the same value after a crash, so the retry the far side sees is recognisably
   * the same request rather than a second one.
   *
   * ```ts
   * import type { WorkflowCtx } from "@alexkroman1/aai";
   *
   * declare function charge(amount: number, idempotencyKey: string): Promise<void>;
   *
   * export async function chargeFlow(input: { amount: number }, ctx: WorkflowCtx) {
   *   const idempotencyKey = await ctx.uuid();
   *   await ctx.step("charge", () => charge(input.amount, idempotencyKey));
   * }
   * ```
   *
   * **Not a hook TOKEN.** {@link WorkflowCtx.waitFor}'s token must be DERIVED
   * from the run's own input, because whoever signals is usually a tool and a tool
   * cannot see the body's local variables — a journaled uuid is stable across
   * replays and still unnameable from outside the body.
   *
   * **Not legal inside a {@link WorkflowCtx.step}**, for
   * {@link WorkflowCtx.now}'s reason.
   */
  uuid(): Promise<string>;
  /**
   * Wait, durably — for a duration in milliseconds, or until an absolute `Date`.
   *
   * **This is not `setTimeout`, and the difference is the whole point.** The run
   * SUSPENDS: the body stops, the process is free, and the engine re-delivers the
   * run when the time comes — which is what makes "check back tomorrow" a thing a
   * workflow can express at all.
   *
   * ## `label` is the wait's IDENTITY, exactly as a step's name is
   *
   * It is journaled as `sleep!<label>#<occurrence>`, so a `label` is what makes
   * a wait survive a body that reaches a different NUMBER of waits than the walk
   * that journaled them — a wait behind a condition, a wait added or removed
   * while a run is in flight. Waits used to be keyed by POSITION alone, and then
   * every wait after the one that moved read its predecessor's record: measured,
   * a week-long `ctx.sleep` was skipped in full and the run reported
   * `completed`, with the clock unmoved. `aai-runtime/workflow-replay-divergence.ts`
   * carries that reproduction.
   *
   * So the same rules apply as to {@link WorkflowCtx.step}'s name, and the
   * `Literal` constraint says so at the call site: make it a string literal,
   * give two call sites two labels, and let a loop reuse one — the occurrence
   * count is what separates the iterations.
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
   * await ctx.sleep("review-window", 6 * 60 * 60 * 1000, { correlationId: "review" });
   * await ctx.step("publish", () => publish(input.topic));
   * ```
   *
   * @param label - This wait's identity in the journal. A string LITERAL, for
   *   the reason above; it is also what `aai workflow` prints for a suspended
   *   run, so "review-window" reads where `sleep!0` did not.
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
   *
   *   Deliberately NOT defaulted from `label`, which is a different question:
   *   `label` decides which JOURNAL ROW this wait is, and `correlationId`
   *   decides which waits one `wakeUp` ends. A schedule polled in a loop wants
   *   one label and one correlation id across every iteration; two independent
   *   waits want two labels and may well want one shared id.
   */
  sleep<const Label extends string>(
    label: Label & Literal<Label>,
    until: number | Date,
    options?: SleepOptions,
  ): Promise<void>;
  /**
   * Wait for somebody OUTSIDE the run to answer, and resolve what they sent.
   *
   * Suspends like {@link WorkflowCtx.sleep} and with no deadline at all: the run
   * waits until `ctx.workflows.signal(token, payload)` is called. That is how a
   * run parks on a human approval, a review that may take a week, or anything
   * else somebody else decides.
   *
   * **The WEBHOOK route reaches this.** `ctx.workflows.publicWebhookUrl(token)`
   * mints a URL that `createRuntimeServer` serves, and a delivery to it resolves the
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
   * `options.schema` — the type parameter is a claim, not a check, and until
   * that option existed this paragraph was advice with no mechanism under it. A
   * schema SUPERSEDES the parameter, and a payload failing one fails the RUN
   * fatally with the window left as the delivery found it;
   * {@link WaitForOptions.schema} carries why none of the three can be otherwise.
   *
   * ## A deadline is an OPTION, and still the one to reach for
   *
   * "Wait for an answer, but not forever" is the common case — Temporal's
   * `timeoutOrUserAction`, and what a retention gate or an approval window is.
   * Write it as `waitFor(token, { timeoutMs })`, which resolves `undefined` when
   * the window closes unanswered.
   *
   * **`Promise.race([ctx.waitFor(t), ctx.sleep(ms)])` does now COMPOSE**, and
   * this paragraph used to say it could not. A wait no longer unwinds the stack:
   * it hands back a promise that never settles, so the body walks on and reaches
   * every wait a `race` or an `all` puts in front of it, and the run suspends
   * ONCE afterwards carrying the earliest deadline among them. Whichever wait
   * ends first is the one the race resolves on, on the delivery that ends it.
   *
   * The parameter is still the better API for a DEADLINE, and for two reasons
   * the composition does not give you. `timeoutMs` is journaled with the hook,
   * so one decision fixes the window; a raced `ctx.sleep` is a second wait whose
   * own deadline is fixed at ITS first reach, so the two agree only by accident.
   * And the timeout arm CLOSES the hook — a compare-and-set — before the body
   * continues, which is what stops a signal landing a moment later from making
   * the next replay answer a window this one timed out. A race has no such
   * moment. So reach for a race when the two waits are genuinely independent (a
   * review window beside a retry backoff), not to put a deadline on one wait.
   *
   * @param token - Who is being waited for, and also this wait's IDENTITY in
   *   the journal — it is keyed `hook!<token>#<occurrence>`, which is what makes
   *   a wait survive a body that reaches a different number of them (see the
   *   module doc). Two concurrent waits in one body must use different tokens,
   *   or a single signal resolves whichever the journal registered first and the
   *   other waits forever.
   * @param options - `timeoutMs` closes the window. Measured from the first time
   *   the wait is REACHED and journaled there, so a replay does not extend it.
   *   `schema` checks what the signaller actually sent, and decides the type.
   * @typeParam T - What the signaller is expected to send. A `schema` supersedes
   *   it, which is the point: the parameter is a claim and the schema is a check.
   */
  waitFor<S extends StandardSchemaV1>(
    token: string,
    options: WaitForOptions<S> & WaitForSchemaOptions<S>,
  ): Promise<InferSchemaOutput<S> | undefined>;
  waitFor<S extends StandardSchemaV1>(
    token: string,
    options: WaitForSchemaOptions<S>,
  ): Promise<InferSchemaOutput<S>>;
  waitFor<T = unknown>(token: string): Promise<T>;
  waitFor<T = unknown>(token: string, options: WaitForOptions): Promise<T | undefined>;
};
