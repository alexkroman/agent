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
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/**
 * A run's observable state — the status union, the terminal set, the snapshot a
 * caller reads and its guard. Re-exported because `ctx.workflows` returns them
 * and this module is the one an author imports.
 */
export {
  isTerminal,
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
 * declaration site — which is the wrong place to report it. {@link workflow}
 * checks it at runtime instead, where the error can say that the bundler plugin
 * is missing.
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
};

/** Per-run options for {@link WorkflowClient.start}. */
export type StartOptions = {
  /**
   * A caller's own handle on this run, for looking it up again later with
   * {@link WorkflowClient.find}.
   *
   * **This is the one piece of durable-workflow machinery the Workflow DevKit
   * has no equivalent for, and it is kept because a VOICE agent is broken
   * without it.** `start` resolves with a `runId`; the natural place a tool puts
   * it is `ctx.state`, and per-session state is swept `SESSION_RESUME_GRACE_MS`
   * after the caller hangs up. So the run outlives the session and the only
   * handle to it does not. Passing `key: ctx.sessionId` (or a phone number, an
   * account id, an upload id) means the next turn — or the next CALL — can find
   * the run again without the agent maintaining its own index in `ctx.db`.
   *
   * Not unique: starting twice with one key is legal and `find` returns the
   * newest first. Deduplicating is a decision only the caller can make.
   */
  key?: string;
};

/** Options for {@link WorkflowClient.find}. */
export type FindOptions = {
  /**
   * Most runs to return, newest first. Defaults to
   * `DEFAULT_WORKFLOW_FIND_LIMIT` and is clamped to
   * `MAX_WORKFLOW_FIND_LIMIT`.
   */
  limit?: number;
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
 * A {@link WorkflowClient} whose every method rejects with `message`.
 *
 * What `ctx.workflows` IS when there is nothing behind it — no workflows
 * declared, no world configured, or a test that did not stub one. One factory
 * rather than a literal per site, because the literal wants writing three times
 * (the tool executor's stub, the host test helper's, and
 * `@alexkroman1/aai/testing`'s) and adding a method to the client would break
 * all three at once while each looked complete on its own.
 *
 * The message is the caller's because the cases want different ones: the
 * runtime's names the missing configuration, a test's names the missing stub.
 *
 * @public
 */
export function rejectingWorkflows(message: string): WorkflowClient {
  // One rejector shared by every method: they differ only in return type, and
  // `never` satisfies all of them.
  const reject = (): Promise<never> => Promise.reject(new Error(message));
  // `listing` cannot reject — it is synchronous — and an empty list is the
  // truthful answer for every case this factory covers.
  return {
    start: reject,
    get: reject,
    find: reject,
    recent: reject,
    cancel: reject,
    listing: () => [],
  };
}

/**
 * The error a declaration gets when its `run` carries no `workflowId`.
 *
 * Its own export because two layers throw it: {@link workflow} at declaration
 * time, and the client when it resolves a def it was handed. Naming the bundler
 * plugin is the whole value — the symptom otherwise is
 * `start` rejecting with WDK's own "invalid workflow function", which points an
 * agent author at the SDK rather than at their build.
 *
 * @internal
 */
export const MISSING_WORKFLOW_ID_MESSAGE =
  'workflow({ run }) was given a function with no "use workflow" directive, or the ' +
  "Workflow DevKit bundler plugin did not run. Declare the body in a module under " +
  '`workflows/`, put `"use workflow";` as its first statement, and make sure the ' +
  "project is built by `aai build`/`aai dev` rather than a bare bundler.";

/**
 * Declare a durable workflow.
 *
 * Nearly an identity function, exactly like {@link tool} — it returns the input
 * unchanged, and exists for type inference. The one thing it does at runtime is
 * check that `run` really was transformed, because that is the mistake with the
 * worst error message if left to be discovered later (see
 * {@link MISSING_WORKFLOW_ID_MESSAGE}). Workflows are named by the key they are
 * declared under, so this takes no `name`.
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
  if (typeof def.run !== "function" || !def.run.workflowId) {
    throw new Error(MISSING_WORKFLOW_ID_MESSAGE);
  }
  return def;
}
