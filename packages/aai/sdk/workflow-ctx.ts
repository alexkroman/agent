// Copyright 2026 the AAI authors. MIT license.
/**
 * What a workflow BODY is handed: the journal, expressed as three calls.
 *
 * This is the half of the authoring surface that replaced the Workflow DevKit's
 * `"use workflow"` / `"use step"` directives. The directives were a compile-time
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
 * `aai-cli`'s workflow scan enforces this at build time as an AST pass: code
 * lexically inside a `ctx.step(...)` callback runs once, code outside it
 * replays, and that boundary is decidable without running anything. Under the
 * directives the same check read the BUILT bundle, because the builder stripped
 * step bodies out of it; the lexical form reports a source location instead of a
 * generated line number, which is strictly better for the author.
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
 * two DIFFERENT call sites sharing a literal name alias onto one counter and
 * read each other's results. That is not a convention to remember, it is a build
 * failure — the same scan rejects two distinct `ctx.step` sites in one body using
 * the same literal. A single site in a loop is exactly what the scheme is for and
 * is left alone.
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
};
