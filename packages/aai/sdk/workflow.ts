import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
// Imported as well as re-exported below: a re-export does not bring the name into
// this module's scope, and `WorkflowDef.run` needs it.
import type { WorkflowContext } from "./workflow-context.ts";
// Imported as well as re-exported below: a re-export does not bring the name into
// this module's scope, and `WorkflowClient`'s signatures need it.
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/**
 * The journal's value contract — {@link Journalable} (the type) and
 * {@link findUnjournalable} (the runtime check the engine runs on every step
 * output). Re-exported here because `ctx.step` is where an author meets them.
 */
export { findUnjournalable, type Journalable } from "./journalable.ts";
/**
 * What a workflow's `run` receives — see `workflow-context.ts`. Re-exported
 * because this module is the one an author imports.
 */
export type { WorkflowContext } from "./workflow-context.ts";
/**
 * Limits and the unavailable-engine message — see `workflow-limits.ts`.
 * Re-exported here because this module is where an author meets them.
 */
export {
  DEFAULT_STEP_BACKOFF_MS,
  DEFAULT_STEP_MAX_ATTEMPTS,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_CONTINUATIONS,
  MAX_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_STEPS,
  WORKFLOWS_UNAVAILABLE_MESSAGE,
} from "./workflow-limits.ts";
/**
 * A run's observable state — the status union, the terminal set, the snapshot a
 * caller reads and its guard. Re-exported because `ctx.workflows` returns them.
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
export type { StepOptions } from "./workflow-steps.ts";

/**
 * Definition of one durable workflow.
 *
 * @typeParam P - Input schema (any Standard Schema, Zod by convention), used
 *   to validate the input {@link WorkflowClient.start} was called with. The
 *   input is journaled, so it must be JSON-serializable.
 * @typeParam R - What `run` resolves with, inferred from the function. It
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
  /** The workflow body. Called on every replay, from the top. */
  run(input: InferSchemaOutput<P>, ctx: WorkflowContext): Promise<R> | R;
};

/** Any workflow definition, for a signature that only needs its output type. */
export type AnyWorkflowDef<R = unknown> = WorkflowDef<ToolInputSchema, R>;

/**
 * One declared workflow, as `GET /workflows` lists it.
 *
 * Here rather than in `host/` because both ends need it and only one of them is
 * a Node process: the API serves it, and a static page's client renders a form
 * from it. It was an inline `{ name: string; description?: string }` at three
 * host sites plus a fourth copy in `aai-ui`, which is four definitions of a
 * wire shape.
 *
 * @public
 */
export type WorkflowSummary = {
  /** Key the workflow is declared under in `agent({ workflows })`. */
  name: string;
  /** The workflow's own `description`, when it declared one. */
  description?: string;
};

/** Per-run options for {@link WorkflowClient.start}. */
export type StartOptions = {
  /**
   * A caller's own handle on this run, for looking it up again later with
   * {@link WorkflowClient.find}.
   *
   * This is what makes a durable run usable from a VOICE agent, and without it
   * the guarantee the mechanism sells is one an author cannot reach: `start`
   * resolves with a `runId`, the natural place a tool puts it is `ctx.state`,
   * and per-session state is swept `SESSION_RESUME_GRACE_MS` after the caller
   * hangs up. So the run outlives the session and the only handle to it does
   * not. Passing `key: ctx.sessionId` (or a phone number, an account id, an
   * upload id) means the next turn — or the next CALL — can find the run again
   * without the agent maintaining its own index in `ctx.db`.
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
   * {@link DEFAULT_WORKFLOW_FIND_LIMIT} and is clamped to
   * {@link MAX_WORKFLOW_FIND_LIMIT}.
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
 * `agent({ workflows })`, so that record is still the single source of the name
 * the journal records: there is no second place for a rename to have to reach.
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
   * fails its schema, or when storage is not enabled for the app.
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
   * Send a FAILED or CANCELLED run back to the queue, resolving whether this call
   * is what revived it (false for one that is still live, or absent).
   *
   * A resume rather than a restart: the journal is kept, so replay short-circuits
   * every step that already succeeded and the run re-runs from where it stopped.
   * Re-running completed work would be wasteful and, for a step with an external
   * side effect, wrong — at-least-once is a per-step contract, not a per-click one.
   *
   * The operator's counterpart to {@link cancel}: before it, a failed run was a
   * dead end. Note this cannot repair a run whose WORKFLOW no longer exists in the
   * deployed bundle — that failure recurs on the next attempt, by design.
   */
  retry(runId: string): Promise<boolean>;
  /**
   * Stop a run. Resolves true when this call is what ended it, false when it
   * was already terminal (or no such run exists).
   *
   * A cancelled run is terminal: it is never claimed again, and its journal is
   * kept so what it did before stopping stays readable. Cancellation reaches an
   * EXECUTING run promptly only on the host executing it, where `ctx.signal`
   * aborts; a run in flight on another replica finishes its current step and
   * then finds its terminal write refused, so the status a caller reads is
   * `cancelled` either way and the difference is only how much work was wasted.
   */
  cancel(runId: string): Promise<boolean>;
  /**
   * The workflows this agent declares, name + description.
   *
   * Synchronous, and on the CLIENT rather than only on the engine, because tool
   * code is a legitimate reader: the `workflow_status` builtin has to ask about
   * every declared workflow when the model named none, and nothing else in
   * `ToolContext` could tell it what those are. Empty when no engine is available,
   * which is the same answer as "this app declares none".
   */
  listing(): WorkflowSummary[];
};

/**
 * A {@link WorkflowClient} whose every method rejects with `message`.
 *
 * What `ctx.workflows` IS when there is no engine behind it — no workflows
 * declared, storage off, or a test that did not stub one. One factory rather
 * than a literal per site, because the literal was written three times (the tool
 * executor's {@link WORKFLOWS_UNAVAILABLE_MESSAGE} stub, the host test helper's,
 * and `@alexkroman1/aai/testing`'s) and adding a method to the client broke all
 * three at once while each looked complete on its own.
 *
 * The message is the caller's because the three cases want different ones: the
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
    retry: reject,
    cancel: reject,
    listing: () => [],
  };
}

/**
 * Define a durable workflow.
 *
 * An identity function for type inference, exactly like {@link tool} — the
 * returned object is the input unchanged. Workflows are named by the key they
 * are declared under, so this takes no `name`.
 *
 * @example
 * ```ts
 * import { agent, tool, workflow } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const digest = workflow({
 *   description: "Research a topic overnight and store the result",
 *   input: z.object({ topic: z.string() }),
 *   async run({ topic }, ctx) {
 *     const notes = await ctx.step("research", () =>
 *       ctx.generate({ prompt: `Summarize today's news about ${topic}` }),
 *     );
 *     await ctx.sleep(60_000);
 *     await ctx.step("save", () =>
 *       ctx.db.query("insert into digests (topic, body) values ($1, $2)", [topic, notes.text]),
 *     );
 *     return { topic };
 *   },
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
