// Copyright 2026 the AAI authors. MIT license.
/**
 * The authoring surface for durable workflows: what a workflow IS, as opposed to
 * how one runs.
 *
 * A workflow is a declaration — a description, an input schema, and a body — and
 * nothing here executes anything. The engine lives in
 * `@alexkroman1/aai-runtime`, and the seam between them is {@link WorkflowCtx},
 * which the engine constructs and hands to the body. That split is what lets an
 * `agent.ts` import this module without pulling a journal, a queue client or a
 * database driver into the agent bundle.
 *
 * What the declaration carries, and why none of it can live on the function:
 *
 * - an **input schema**, so a run started from a tool call or an HTTP request is
 *   validated at the call site rather than crashing three steps in, and so a
 *   page can render a form from it;
 * - an **output schema**, the same declaration from the other end: what a
 *   completed run promises its caller, checked once where the run completes and
 *   served to the page as JSON Schema beside the input one;
 * - a **description**, for that page and for `aai workflow`;
 * - **`uploads`**, naming the input properties that carry an upload id rather
 *   than bytes;
 * - a **name**, the key it is declared under in `agent({ workflows })` — and,
 *   since the Workflow DevKit was removed, the workflow's identity everywhere
 *   else too.
 *
 * ## What an author writes
 *
 * The body is an ordinary exported async function in its own module under
 * `workflows/`. No directive and no compile step of its own — the agent
 * bundle's Vite pass compiles it like any other source file:
 *
 * ```ts no-check
 * // workflows/digest.ts
 * import type { WorkflowCtx } from "@alexkroman1/aai/workflow";
 *
 * export async function digestFlow(input: { topic: string }, ctx: WorkflowCtx) {
 *   const notes = await ctx.step("research", () => research(input.topic));
 *   await ctx.step("save", () => save(input.topic, notes));
 *   return { topic: input.topic };
 * }
 * ```
 *
 * and declares it in `agent.ts`:
 *
 * ```ts no-check
 * export const digest = workflow({
 *   description: "Research a topic overnight and store the result",
 *   input: z.object({ topic: z.string() }),
 *   run: digestFlow,
 * });
 * ```
 *
 * ## The rule that outlived the engine
 *
 * A body is REPLAYED from the top on every resume, so it may hold no live handle
 * and may do nothing non-deterministic outside a step. That was true of the
 * DevKit's `"use step"` and is true of `ctx.step`: the mechanism changed, the
 * constraint did not. `ctx.db` and `ctx.generate` are absent from a body for
 * exactly that reason — both belong inside a step, which runs at most once per
 * successful execution and has the whole Node runtime.
 *
 * {@link WorkflowCtx} carries the rest, including why step identity is a name
 * plus an occurrence count — and that nothing checks the replay rule for you.
 */

import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
// The zod-free half of schema acceptance, and the only half this module may
// name: `sdk/schema.ts` imports zod for JSON Schema conversion, and everything
// here rides the `@alexkroman1/aai/workflow-api` subpath a workflow app's PAGE
// bundles. Validation is a plain method call on `~standard`, so an output
// schema costs that bundle nothing. `sdk/step-generate-json.ts` is the
// precedent; the conversion for a listing happens one package over, in the
// runtime, which is a Node process and may pull zod.
import type { StandardSchemaV1 } from "./standard-schema.ts";
// The body's second argument. Type-only here, but re-exported below: an author
// writing a body needs to name it, and `workflow.ts` is the one module they
// already import from.
import type { WorkflowCtx } from "./workflow-ctx.ts";
// Type-only, so the cycle with `workflow-run.ts` (which names `WorkflowClient`
// in its own docs) is erased rather than real. `WorkflowRunOf` composes the
// snapshot with a def's output type, and the composition belongs beside the
// two halves an author already reads here.
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/**
 * `ctx.workflows` — the type of the handle, re-exported because `ToolContext`
 * names it and a tool body annotating one should not need a second import.
 *
 * The rest of the RUN vocabulary is on `@alexkroman1/aai/workflow-api`: the
 * option bags, the snapshot union, its guard and the wait cap. The line is
 * DECLARATION versus RUN — an `agent.ts` declares a workflow, and everything
 * about what a run IS is read by a caller (a page, a script, a tool annotating a
 * result), which is exactly the audience that subpath already exists for. It
 * was seventeen names on the root barrel whose reader is never `agent.ts`.
 */
export type { WorkflowClient } from "./workflow-client.ts";
export {
  DEFAULT_STEP_MAX_ATTEMPTS,
  type SleepOptions,
  type StepOptions,
  type WaitForOptions,
  type WorkflowCtx,
} from "./workflow-ctx.ts";

/**
 * A workflow body: an ordinary async function of its input and a
 * {@link WorkflowCtx}.
 *
 * **There is no `workflowId` any more, and its absence is the point.** Under the
 * Workflow DevKit this type carried one, attached by a compile-time transform,
 * and `start()` read it — so a body that the bundler plugin had not reached
 * looked perfectly valid at the declaration site and failed at the first
 * `start()` with `MISSING_WORKFLOW_ID`. An agent that builds, deploys, boots and
 * answers the phone but cannot start a run is a bad failure to design in. A
 * workflow is now identified by the key it is declared under in
 * `agent({ workflows })`, which cannot go missing because the declaration IS the
 * registration.
 *
 * The body is REPLAYED — see {@link WorkflowCtx} for what that forbids.
 *
 * @typeParam I - The body's validated input.
 * @typeParam R - What the body returns.
 *
 * @public
 */
export type WorkflowBody<I = unknown, R = unknown> = (input: I, ctx: WorkflowCtx) => Promise<R> | R;

/**
 * Definition of one durable workflow: its schema, its description, and the
 * function that is its body.
 *
 * @typeParam P - Input schema (any Standard Schema, Zod by convention),
 *   validated at `start()`. The input is serialized into the run record, so it
 *   must be JSON-serializable.
 * @typeParam R - What the body resolves with — inferred from the declared
 *   {@link WorkflowDef.output} schema when there is one, and from the function
 *   otherwise. It reaches a caller as `WorkflowRunSnapshot`'s `output`, so
 *   passing the workflow to `start`/`get`/`find` is what makes a completed
 *   run's result typed instead of `unknown`.
 *
 * @public
 */
export type WorkflowDef<P extends ToolInputSchema = ToolInputSchema, R = unknown> = {
  /** What this workflow does. Not shown to an LLM — workflows are started by code, not chosen by a model. */
  description?: string;
  /** Schema for the run input, validated at `start()` so a bad payload fails at the call site. */
  input?: P;
  /**
   * Input properties that carry an UPLOAD ID rather than a value of their own.
   *
   * A run's input is journaled and replayed on every resume, so a file's bytes
   * may not travel in it — the bytes go to `POST /workflows/uploads` and the
   * input carries the id it answered with, which a step reads windows of through
   * `readUpload`. Naming the property here is what makes that automatic at both
   * ends: `<WorkflowFields>` renders a file picker for it instead of a text box,
   * and `useWorkflowSubmit` uploads the chosen file and substitutes its id.
   *
   * Declared on the workflow rather than in the schema because the schema may be
   * any Standard Schema, and a marker inside one would only work for the library
   * that happened to carry it. The property itself stays an ordinary
   * `z.string()` — an upload id is what the run really receives.
   */
  uploads?: readonly string[];
  /**
   * Schema for what a COMPLETED run answers with — `input` from the other end.
   *
   * Optional, and a workflow that declares none behaves exactly as it always
   * did. What declaring one buys is three things a body's inferred return type
   * cannot:
   *
   * - **The value is checked where the run completes**, once, against this
   *   schema; a body that returns something the declaration denies fails the
   *   run rather than reporting `completed` with an output its own workflow
   *   says is impossible. A run's output crosses a durable journal, a
   *   typed-JSON codec and an HTTP hop before a page reads it, and
   *   `useWorkflowRun<R>`'s `run.output` is otherwise an unchecked CLAIM about
   *   everything that happened in between.
   * - **{@link WorkflowOutputOf} reads THIS**, so a page's type comes from the
   *   declaration rather than from inferring the body — which is what lets an
   *   annotated `agent.ts` resolve it without the body's signature. See that
   *   type for the circularity that removes.
   * - **A page can render results the way it renders the form**, because the
   *   listing serves it as JSON Schema ({@link WorkflowSummary.outputSchema}).
   *
   * Any Standard Schema, Zod by convention — the same acceptance as `input`,
   * and not a TypeScript type for the same reason: a type is erased, and this
   * has to be checked at run time and converted for a browser.
   *
   * What is stored is the schema's PARSED value, exactly as `start()` stores
   * the parsed input. So an unknown key a zod object strips is not in what the
   * caller reads back, and the type a caller holds is a promise the run kept
   * rather than a claim about it.
   */
  output?: StandardSchemaV1<unknown, R>;
  /**
   * The workflow body.
   *
   * Takes the validated input and a {@link WorkflowCtx}. The input is ONE
   * object rather than a positional list on purpose — it is schema-validated,
   * and a schema describes one value.
   */
  run: WorkflowBody<InferSchemaOutput<P>, R>;
};

/**
 * Any workflow definition, for a signature that only needs its OUTPUT type.
 *
 * Not `WorkflowDef<ToolInputSchema, R>`, which is the obvious spelling and does
 * not work: a body's input is a function PARAMETER, so it is contravariant, and
 * a `run` taking `{ topic: string }` is not assignable to one taking the open
 * `Record<string, unknown>`. Every schema-carrying workflow would fail to match.
 * Typing the parameter as `never` inverts that — `never` is assignable to every
 * parameter type — which is exactly right for a position that only ever reads
 * `R`, and makes the def unusable for CALLING the body, which nothing here does.
 */
export type AnyWorkflowDef<R = unknown> = {
  description?: string;
  input?: ToolInputSchema;
  uploads?: readonly string[];
  // Mirrors `WorkflowDef.output` rather than being widened to
  // `StandardSchemaV1`: `R` is the one thing this type exists to carry, and the
  // schema is now the DECLARED source of it, so a def matched here has to say
  // the same thing about `R` through either member.
  output?: StandardSchemaV1<unknown, R>;
  run: WorkflowBody<never, R>;
};

/**
 * A workflow's OUTPUT type, for a page that polls its runs.
 *
 * This is the end-to-end typing a static page would otherwise be missing.
 * `useWorkflowRun<R>` makes `run.status === "completed"` narrow to a typed
 * `run.output`, and without this the page has to name `R` by hand — restating a
 * shape the agent module already declares, with nothing checking the two agree.
 *
 * It needs no build step and no generated `.d.ts`, because the reason a page
 * "cannot import the agent" does not survive contact with `import type`: a
 * type-only import is ERASED, so it drags no server graph into the browser
 * bundle.
 *
 * @example
 * ```ts no-check
 * // agent.ts
 * export const transcribe = workflow({ input: …, output: transcriptSchema, run: transcribeFlow });
 *
 * // client.tsx — `import type` is erased, so nothing server-side is bundled.
 * import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
 * import type { transcribe } from "./agent.ts";
 *
 * const run = useWorkflowRun<WorkflowOutputOf<typeof transcribe>>(runId, { api });
 * if (run?.status === "completed") console.log(run.output.text); // typed
 * ```
 *
 * ## It reads the declared SCHEMA first, and that is what breaks a cycle
 *
 * The DECLARATION is the better source of this type, and the worse one used to
 * be the only one. Deriving `R` from the body means `typeof theDef` needs the
 * body's signature — while a body annotated `WorkflowInputOf<typeof theDef>`
 * needs `typeof theDef`, which is `TS7022` reported against `agent.ts`. The
 * documented way out is to ANNOTATE the declaration, and an annotation whose
 * `R` comes from a schema (`WorkflowDef<typeof digestInput, z.infer<typeof
 * digestOutput>>`) states the output type once, in the schema, rather than
 * naming it a second time by hand.
 *
 * That annotated shape is also what the second reading gets WRONG, which is
 * the other half of this rewrite. `D extends WorkflowDef<ToolInputSchema, infer
 * R>` is an assignability test over the whole def, and `run`'s input is a
 * function PARAMETER — so a def carrying an input schema is not assignable to
 * one taking the open `Record<string, unknown>`, and the conditional silently
 * fell to `never`. It is the same contravariance {@link AnyWorkflowDef} was
 * written for, reached by the other route, and it is why the test below matches
 * `run` as `WorkflowBody<never, infer R>` — `never` is assignable to every
 * parameter type.
 *
 * `unknown extends O` is how "declared nothing" is told from "declared a
 * schema": a def with no output schema still HAS the optional property in its
 * type, carrying `R` — so the two readings agree, and the fallback only ever
 * fires for a def-shaped object that names no output at all.
 *
 * `Awaited` because a body may be sync or async and the snapshot always holds
 * the settled value.
 *
 * @public
 */
export type WorkflowOutputOf<D> = D extends {
  run: WorkflowBody<never, infer R>;
  output?: StandardSchemaV1<unknown, infer O> | undefined;
}
  ? Awaited<unknown extends O ? R : O>
  : never;

/**
 * A workflow's INPUT type — what its declared schema parses to, which is
 * exactly what the body's parameter should be.
 *
 * **The reason it exists is that nothing checks a hand-written parameter.**
 * {@link WorkflowBody} takes its input as a function PARAMETER, so it is
 * contravariant: a body declaring a WIDER shape than the schema produces is
 * assignable, and a body declaring the same shape with a field's optionality or
 * a default's type subtly different is assignable too. Both compile. A
 * `z.number().default(5)` against a body that writes `input.limit ?? 3` is the
 * sharp version — the schema guarantees `limit` is present, the `??` is dead,
 * and the two numbers disagree with nothing to report it.
 *
 * Two details a restated shape gets wrong by hand, both of which this gets
 * right for free. A zod `.optional()` infers a property that may be PRESENT AND
 * `undefined`, which under `exactOptionalPropertyTypes` is `?: T | undefined`
 * and not `?: T` — two templates carry the same four-line comment explaining
 * that, which is a comment `z.infer` makes unnecessary. And a `.default()` makes
 * the OUTPUT property required while the input stays optional, so a body reading
 * it needs no fallback at all.
 *
 * Like {@link WorkflowOutputOf}, it needs no build step: `import type` is
 * erased, so a body in `workflows/` naming `WorkflowInputOf<typeof theDef>`
 * through a type-only import of `../agent.ts` drags no runtime cycle behind it.
 *
 * @example
 * ```ts no-check
 * // agent.ts
 * export const digest = workflow({
 *   input: z.object({ topic: z.string(), limit: z.number().default(5) }),
 *   run: digestFlow,
 * });
 *
 * // workflows/digest.ts — `import type` is erased, so there is no cycle.
 * import type { WorkflowInputOf } from "@alexkroman1/aai/workflow-api";
 * import type { digest } from "../agent.ts";
 *
 * export async function digestFlow(input: WorkflowInputOf<typeof digest>, ctx: WorkflowCtx) {
 *   // `limit` is `number`, not `number | undefined` — the default already ran.
 *   return await research(input.topic, input.limit);
 * }
 * ```
 *
 * @public
 */
export type WorkflowInputOf<D> =
  D extends WorkflowDef<infer P, unknown> ? InferSchemaOutput<P> : never;

/**
 * A run of `D`, with its output already typed — `WorkflowRunSnapshot` and
 * {@link WorkflowOutputOf} composed.
 *
 * The composition is what a tool reporting on a run actually holds, and writing
 * it out costs a three-name import (`WorkflowRunSnapshot`, `WorkflowOutputOf`,
 * and the def) at every such tool. Two templates compose it by hand today, in
 * files whose whole job is to answer "how is that run going".
 *
 * The result is still the DISCRIMINATED union, so `isTerminal(run)` and
 * `run.status === "completed"` narrow exactly as they do on the uncomposed type
 * — this names the shape, it does not flatten it.
 *
 * @example
 * ```ts no-check
 * import { isTerminal, type WorkflowRunOf } from "@alexkroman1/aai/workflow-api";
 * import type { research } from "../agent.ts";
 *
 * function describe(run: WorkflowRunOf<typeof research>): string {
 *   if (!isTerminal(run)) return "still working on it";
 *   return run.status === "completed" ? run.output.summary : "that one did not finish";
 * }
 * ```
 *
 * @public
 */
export type WorkflowRunOf<D> = WorkflowRunSnapshot<WorkflowOutputOf<D>>;

/**
 * One declared workflow, as `GET /workflows` lists it.
 *
 * Here rather than in `host/` because both ends need it and only one of them is
 * a Node process: the API serves it, and a static page's client renders a form
 * from it.
 *
 * @public
 */
export type WorkflowSummary = {
  /** Key the workflow is declared under in `agent({ workflows })`. */
  name: string;
  /** The workflow's own `description`, when it declared one. */
  description?: string;
  /**
   * JSON Schema for the run input, when the workflow declared one — what a page
   * renders its form from. Converted at declaration-listing time rather than
   * shipped as the Standard Schema itself, because the reader is a browser.
   */
  inputSchema?: unknown;
  /**
   * JSON Schema for what a completed run answers with, when the workflow
   * declared an `output` — what a page renders its RESULTS from, the way
   * `inputSchema` is what it renders its form from.
   *
   * Converted at declaration-listing time for the same stated reason: the
   * reader is a browser, and a Standard Schema does not survive the wire.
   *
   * The two are converted in opposite DIRECTIONS and the asymmetry is not an
   * oversight — see the converter in the runtime's `workflow-client.ts`. An
   * input schema is described as what a caller may SEND (a `.default()` field
   * is optional); an output schema as what the run PRODUCES, which is the
   * parsed value, where that same field is always present.
   */
  outputSchema?: unknown;
  /**
   * Input properties that carry an upload id — see `WorkflowDef.uploads`.
   *
   * Served alongside the schema because a form is rendered from BOTH: the schema
   * says the property is a string, and this says the string is a file the page
   * has to upload first.
   */
  uploads?: readonly string[];
};

/**
 * Declare a durable workflow.
 *
 * An identity function for type inference, exactly like `tool()` — the returned
 * object is the input unchanged. Workflows are named by the key they are declared
 * under, so this takes no `name`.
 *
 * @remarks
 * **Three primitives here run a defined process; pick by SCOPE.** A
 * {@link dialog} gates a CONVERSATION — what the agent may say or do next,
 * across turns, persisted in a session slot. A {@link procedure} runs ONE UNIT
 * OF WORK inside a single tool call, never stored. A {@link workflow} runs
 * DURABLY, outliving the session.
 *
 * It validates nothing at declaration time, and there is nothing left to
 * validate: a body is an ordinary function and a workflow's identity is the key
 * it is declared under, so the `workflowId` a compiler used to attach — and the
 * check that used to look for it — are both gone. See {@link WorkflowBody}.
 *
 * **Two signatures, and which one applies is decided by `output`.** With an
 * output schema the result type comes from the SCHEMA and the body is CHECKED
 * against it — a body returning something else is an error at the declaration,
 * naming the property that disagrees, rather than quietly redefining what the
 * workflow promises. With no `output` nothing changes: the result type is
 * inferred from the body exactly as before. Both answer the same
 * `WorkflowDef<P, R>`, so nothing downstream can tell which was used.
 *
 * @example
 * `agent.ts` — declare the workflow beside the agent. A tool is a FILE, so
 * `agent()` takes no `tools`. Declaring `output` beside `input` is what makes
 * the run's result checked where it completes and typed where it is read.
 * ```ts no-check
 * import { agent, workflow } from "@alexkroman1/aai";
 * import { z } from "zod";
 * import { digestFlow } from "./workflows/digest.ts";
 *
 * export const digest = workflow({
 *   description: "Research a topic overnight and store the result",
 *   input: z.object({ topic: z.string() }),
 *   output: z.object({ topic: z.string(), headline: z.string() }),
 *   run: digestFlow,
 * });
 *
 * export default agent({
 *   name: "Researcher",
 *   workflows: { digest },
 * });
 * ```
 *
 * @example
 * `tools/research.ts` — the tool that starts a run.
 * ```ts no-check
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 * import { digest } from "../agent.ts";
 *
 * export default tool({
 *   description: "Kick off overnight research on a topic",
 *   inputSchema: z.object({ topic: z.string() }),
 *   execute: async ({ topic }, ctx) => {
 *     // The workflow itself, not its name: typed input, and a typo is a
 *     // compile error. `key` is what lets a later turn find this run.
 *     const runId = await ctx.workflows.start(digest, { topic }, { key: ctx.sessionId });
 *     return `Working on it — run ${runId}.`;
 *   },
 * });
 * ```
 *
 * @public
 */
export function workflow<
  P extends ToolInputSchema = ToolInputSchema,
  O extends StandardSchemaV1 = StandardSchemaV1,
>(
  def: Omit<WorkflowDef<P, InferSchemaOutput<O>>, "output"> & { output: O },
): WorkflowDef<P, InferSchemaOutput<O>>;
export function workflow<P extends ToolInputSchema = ToolInputSchema, R = unknown>(
  def: WorkflowDef<P, R>,
): WorkflowDef<P, R>;
export function workflow(def: WorkflowDef): WorkflowDef {
  return def;
}
