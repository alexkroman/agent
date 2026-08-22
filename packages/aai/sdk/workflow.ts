// Copyright 2026 the AAI authors. MIT license.
/**
 * The authoring surface for durable workflows.
 *
 * **The engine is the Workflow Development Kit; none of it is here.** Replay,
 * the event log, step retries, suspension and recovery all belong to
 * `workflow@4`, and this module holds only what WDK's compile-time directives
 * cannot carry:
 *
 * - an **input schema**, so a run started from a tool call or an HTTP request is
 *   validated at the call site rather than crashing three steps in, and so a
 *   page can render a form from it;
 * - a **description**, for the same page and for `aai workflow`;
 * - a **name**, which is the key the workflow is declared under in
 *   `agent({ workflows })`.
 *
 * A `"use workflow"` function is a plain async function with a compiler-attached
 * `workflowId`. It takes positional arguments and no context object, so there is
 * nowhere on it to hang any of the three. Hence {@link workflow} — a declaration
 * wrapper, not an executor.
 *
 * ## What an author writes
 *
 * The body is a real directive function, in its own module under `workflows/`
 * (the directory the WDK builder scans):
 *
 * ```ts no-check
 * // workflows/digest.ts
 * import { sleep } from "workflow";
 *
 * export async function digestFlow(input: { topic: string }) {
 *   "use workflow";
 *   const notes = await research(input.topic);
 *   await sleep("6 hours");
 *   await save(input.topic, notes);
 *   return { topic: input.topic };
 * }
 *
 * async function research(topic: string) {
 *   "use step";
 *   // Full Node access, and the place ctx.db / ctx.generate work moved to.
 *   return await callTheModel(topic);
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
 * ## What moved, and why it could not stay
 *
 * `ctx.step(name, fn)` is gone: `"use step"` is the same idea with the retry
 * policy and the event log behind it, and a context method cannot be a compile
 * target. `ctx.waitFor` is gone in favour of WDK's `defineHook()` /
 * `createWebhook()`, which are strictly more capable (a hook is typed and can be
 * resumed more than once). `ctx.db` and `ctx.generate` are gone from the
 * workflow BODY — a body is replayed from the top on every resume, so it may
 * hold no live handle; both belong inside a `"use step"` function, which runs
 * once per successful execution and has the whole Node runtime.
 *
 * That last one is the change most likely to bite, because the old shape
 * compiled and the new one has to be moved by hand. It is also the one that was
 * never sound: a `ctx.db.query` in a replayed body re-ran on every resume.
 */

import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";

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

/**
 * A `"use workflow"` function, as the compiler leaves it.
 *
 * The `workflowId` property is what the WDK's transform attaches and what
 * `start()` reads; it is the whole reason a declaration can name a workflow body
 * without importing the engine. Typed as optional-but-present rather than
 * required because the property does not exist until the transform runs, and a
 * required field would make an untransformed function a compile error at the
 * declaration site — which is the wrong place to report it. `ctx.workflows.start`
 * checks it instead, at the point the id is actually needed, where the error can
 * say that the bundler plugin did not run.
 *
 * @typeParam I - The body's single input argument.
 * @typeParam R - What the body returns.
 *
 * @public
 */
export type WorkflowBody<I = unknown, R = unknown> = ((input: I) => Promise<R> | R) & {
  /** Attached by the WDK compiler: `workflow//{file}//{export}`. */
  workflowId?: string;
};

/**
 * Definition of one durable workflow: its schema, its description, and the
 * `"use workflow"` function that is its body.
 *
 * @typeParam P - Input schema (any Standard Schema, Zod by convention),
 *   validated at `start()`. The input is serialized into the run record, so it
 *   must be JSON-serializable.
 * @typeParam R - What the body resolves with, inferred from the function. It
 *   reaches a caller as `WorkflowRunSnapshot`'s `output`, so passing the
 *   workflow to `start`/`get`/`find` is what makes a completed run's result
 *   typed instead of `unknown`.
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
   * The workflow body: a function carrying `"use workflow"`.
   *
   * Takes ONE argument, the validated input. WDK bodies are variadic
   * (`start(fn, [a, b, c])`), and this narrows that to a single object on
   * purpose — the input is schema-validated, and a schema describes one value.
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
 * export const transcribe = workflow({ input: …, run: transcribeFlow });
 *
 * // client.tsx — `import type` is erased, so nothing server-side is bundled.
 * import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
 * import type { transcribe } from "./agent.ts";
 *
 * const run = useWorkflowRun<WorkflowOutputOf<typeof transcribe>>(runId, { api });
 * if (run?.status === "completed") console.log(run.output.text); // typed
 * ```
 *
 * `Awaited` because a body may be sync or async and the snapshot always holds
 * the settled value.
 *
 * @public
 */
export type WorkflowOutputOf<D> =
  D extends WorkflowDef<ToolInputSchema, infer R> ? Awaited<R> : never;

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
 * It deliberately does NOT check that `run` carries the compiler's `workflowId`.
 * That check belongs where the id is USED (`ctx.workflows.start`, which throws
 * naming the build), because a declaration-time throw makes merely IMPORTING an
 * agent module fail wherever the Workflow DevKit transform has not run — which
 * includes every unit test of a tool that starts a workflow, since vitest loads
 * `agent.ts` as source with no bundler in the path. The first template to declare
 * one is what surfaced this: the throw made the module unimportable by its own
 * spec.
 *
 * @example
 * `agent.ts` — declare the workflow beside the agent. A tool is a FILE, so
 * `agent()` takes no `tools`.
 * ```ts no-check
 * import { agent, workflow } from "@alexkroman1/aai";
 * import { z } from "zod";
 * import { digestFlow } from "./workflows/digest.ts";
 *
 * export const digest = workflow({
 *   description: "Research a topic overnight and store the result",
 *   input: z.object({ topic: z.string() }),
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
export function workflow<P extends ToolInputSchema = ToolInputSchema, R = unknown>(
  def: WorkflowDef<P, R>,
): WorkflowDef<P, R> {
  return def;
}
