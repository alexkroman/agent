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
import type {
  FindOptions,
  StartOptions,
  StreamOptions,
  WakeUpOptions,
} from "./workflow-options.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

// The per-call option bags, re-exported so this stays the one module an author
// imports the workflow surface from.
export type {
  FindOptions,
  StartOptions,
  StreamOptions,
  WakeUpOptions,
} from "./workflow-options.ts";

/**
 * A run's observable state — the status union, the terminal set, the snapshot a
 * caller reads and its guard. Re-exported because `ctx.workflows` returns them
 * and this module is the one an author imports.
 */
export {
  clampWorkflowWait,
  isTerminal,
  MAX_WORKFLOW_WAIT_MS,
  TERMINAL_WORKFLOW_STATUSES,
  type TerminalWorkflowRun,
  // Re-exported because `WorkflowRunSnapshot` intersects it into every member, so
  // it is part of a public type's shape — TypeDoc fails the docs build for a type
  // referenced by a public signature but not reachable from the entry point.
  type WorkflowRunBase,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
} from "./workflow-run.ts";

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
 *   reaches a caller as {@link WorkflowRunSnapshot}'s `output`, so passing the
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
 * import type { WorkflowOutputOf } from "@alexkroman1/aai";
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
 * Start and inspect workflow runs. Reaches tool code as `ctx.workflows`.
 *
 * **Prefer passing the workflow itself over its name.** Every method here is
 * overloaded on `WorkflowDef | string`, and the def overload is the one that
 * types the input against the workflow's own schema, types `output` against its
 * return, and turns a misspelled workflow into a compile error instead of a
 * promise rejection the model reads as a tool failure. The string overload stays
 * for a name that genuinely is data — read from config, a database, a request.
 *
 * The def is resolved to its declared name by IDENTITY against
 * `agent({ workflows })`, so that record stays the single source of the name,
 * and to its `workflowId` through its own `run` function.
 *
 * @public
 */
export type WorkflowClient = {
  /**
   * Create a run and return its id without waiting for it to finish — the
   * point of the whole mechanism. A tool that calls this answers the caller
   * in the same turn ("started, I'll text you") while the run continues past
   * the end of the session.
   *
   * Rejects when the workflow is not declared on this agent, when the input
   * fails its schema, or when no workflow backend is configured.
   */
  start<P extends ToolInputSchema, R>(
    workflow: WorkflowDef<P, R>,
    /**
     * Required for the definition form, even for a workflow that declares no
     * schema — pass `{}` there. Optional would mean a schema-CARRYING workflow
     * could be started with no input by omission, which is the mistake this
     * overload exists to catch; `{}` is a small cost for that.
     */
    input: InferSchemaOutput<P>,
    options?: StartOptions,
  ): Promise<string>;
  start(workflow: string, input?: unknown, options?: StartOptions): Promise<string>;
  /**
   * Look up a run by id. Resolves `undefined` when no such run exists.
   *
   * Pass the workflow as the second argument to type `output` on a completed
   * run; with the id alone there is nothing to infer it from, so it is
   * `unknown`. The argument is used ONLY for that — the run's own record says
   * which workflow it belongs to.
   */
  get<R>(runId: string, of: AnyWorkflowDef<R>): Promise<WorkflowRunSnapshot<R> | undefined>;
  get(runId: string): Promise<WorkflowRunSnapshot | undefined>;
  /**
   * Runs of `workflow` started with this correlation key, newest first.
   *
   * The read half of {@link StartOptions.key} — see there for why a voice agent
   * needs it. Resolves an empty array when nothing matches.
   */
  find<P extends ToolInputSchema, R>(
    workflow: WorkflowDef<P, R>,
    key: string,
    options?: FindOptions,
  ): Promise<WorkflowRunSnapshot<R>[]>;
  find(workflow: string, key: string, options?: FindOptions): Promise<WorkflowRunSnapshot[]>;
  /**
   * Runs of `workflow`, newest first, whatever key they carry.
   *
   * The OPERATOR's read where {@link find} is the agent's. A console — the
   * studio's Settings pane, a `curl` — asking "what has this workflow been doing"
   * holds no correlation key, and most runs carry none at all: a page keeps its
   * own `runId`, so only a voice agent's runs are keyed.
   *
   * Deliberately its own method rather than `find` with an optional key, because
   * a keyless lookup is not a lookup that matched every key. Sharing one method
   * would let a caller meaning "this session's runs" read every session's the
   * moment its key went `undefined` — a scoping bug with no symptom.
   */
  recent<P extends ToolInputSchema, R>(
    workflow: WorkflowDef<P, R>,
    options?: FindOptions,
  ): Promise<WorkflowRunSnapshot<R>[]>;
  recent(workflow: string, options?: FindOptions): Promise<WorkflowRunSnapshot[]>;
  /**
   * Stop a run. Resolves true when this call is what ended it, false when it
   * was already terminal (or no such run exists).
   *
   * A cancelled run is terminal: it is never resumed, and its event log is kept
   * so what it did before stopping stays readable.
   */
  cancel(runId: string): Promise<boolean>;
  /**
   * Interrupt a run's pending `sleep()` calls, resuming it early. Resolves how
   * many sleeps were interrupted — `0` when the run was not sleeping, had
   * already finished, or does not exist.
   *
   * This is the counterpart of a `sleep()` long enough to be worth shortening,
   * which is most of the ones worth writing: a review delay, a retry backoff, a
   * "follow up tomorrow". Without it the only handle on a sleeping run is
   * {@link cancel}, so "send it now" and "throw it away" were the same button.
   *
   * Pass `correlationIds` to target specific sleeps; omitted, every pending one
   * in the run is interrupted.
   */
  wakeUp(runId: string, options?: WakeUpOptions): Promise<number>;
  /**
   * Deliver a payload to a run parked on `createHook({ token })`, resuming it.
   * Resolves true when a hook was listening on `token`, false when none was.
   *
   * **This is the half of the mechanism a voice agent needs and could not
   * reach.** A run that has to WAIT for a person — an approval, a choice, a
   * "yes, go ahead" — parks on a hook, and until now the only way to feed one
   * was the public webhook URL `createWebhook()` mints, which is for a third
   * party with a callback to make. The caller on the phone is neither: they are
   * right here, mid-turn, and the thing that should resume the run is a tool.
   *
   * {@link wakeUp} is not this. It ends a pending `sleep()`, which is a run
   * waiting for TIME; a hook is a run waiting for an ANSWER, and the answer is
   * the payload. A body that raced a hook against a `sleep` — the shape a
   * decision-with-a-deadline takes — needs both, and they mean different things.
   *
   * ## The token is the contract, and it has to be derivable on both sides
   *
   * A hook's token is chosen by the BODY and typed in by the tool, so it must be
   * something each can compute from what it already has:
   * `` `retention:${input.requestedBy}` `` in the body against
   * `` `retention:${ctx.sessionId}` `` in the tool. Put that expression in one
   * exported helper both import, rather than writing the template literal twice.
   *
   * Two properties come with it. A token is claimed by ONE live hook, so two
   * runs that would derive the same token collide — the body detects that with
   * `hook.getConflict()`, and the ordinary fix is the one a voice agent wants
   * anyway: at most one live run per caller. And a token is a capability: it
   * addresses a run, so derive it from something session-scoped rather than from
   * anything a caller could name.
   *
   * ## `false` is an answer
   *
   * Nobody is listening is the normal case, not a failure — the run has moved
   * past its hook, or finished, or was never started. Same shape as
   * {@link cancel} resolving false and {@link wakeUp} resolving `0`, and a voice
   * tool should say so out loud ("that one had already gone ahead") rather than
   * treat it as an error.
   */
  signal(token: string, payload?: unknown): Promise<boolean>;
  /**
   * Read what a run has WRITTEN while running, as a stream.
   *
   * The gap this fills: a snapshot carries a status and, once terminal, an
   * output — so a run that takes ten minutes is `running` for ten minutes and
   * then done, with nothing in between. A workflow that wants to report progress
   * writes to `getWritable()` (imported from `workflow`, like `sleep`), and this
   * is the read side.
   *
   * Chunks are RETAINED with the run, not live-only, so this is equally a replay:
   * a page that reloads mid-run reads the whole stream from the start by default,
   * and `startIndex` is for a reader that knows where it got to.
   *
   * The stream is lazy — a run that does not exist surfaces when it is read, not
   * here — so a caller wanting a clean "no such run" answer should {@link get} it
   * first, which is what the HTTP route does.
   */
  stream(runId: string, options?: StreamOptions): Promise<ReadableStream<unknown>>;
  /**
   * How far the run's stream currently goes: the index of the last chunk
   * written, or `-1` for a stream nothing has written to.
   *
   * **This is what makes reading a progress stream terminate.** A workflow stream
   * reports its end only once it has been CLOSED, and a progress channel written
   * by one step after another is never closed — no step knows it is the last one.
   * So {@link stream} on a finished run yields every chunk and then waits
   * forever. A reader bounds itself by this instead, which is also what a
   * reconnecting reader needs in order to ask for what it has not seen.
   */
  streamTail(runId: string, options?: StreamOptions): Promise<number>;
  /**
   * The workflows this agent declares, name + description + input schema.
   *
   * Synchronous, and on the CLIENT rather than only on the engine, because tool
   * code is a legitimate reader: the `workflow_status` builtin has to ask about
   * every declared workflow when the model named none, and nothing else in
   * `ToolContext` could tell it what those are. Empty when no backend is
   * available, which is the same answer as "this app declares none".
   */
  listing(): WorkflowSummary[];
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
 * ```ts no-check
 * import { agent, tool, workflow } from "@alexkroman1/aai";
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
 *   tools: {
 *     research: tool({
 *       description: "Kick off overnight research on a topic",
 *       inputSchema: z.object({ topic: z.string() }),
 *       execute: async ({ topic }, ctx) => {
 *         // The workflow itself, not its name: typed input, and a typo is a
 *         // compile error. `key` is what lets a later turn find this run.
 *         const runId = await ctx.workflows.start(digest, { topic }, { key: ctx.sessionId });
 *         return `Working on it — run ${runId}.`;
 *       },
 *     }),
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
