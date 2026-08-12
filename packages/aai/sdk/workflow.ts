// Copyright 2026 the AAI authors. MIT license.
/**
 * Durable workflows — the author-facing half.
 *
 * A workflow is work that outlives the session that started it. Where a
 * `tool()` runs inside one turn, on one sandbox, under
 * `TOOL_EXECUTION_TIMEOUT_MS`, a workflow is journaled: each `ctx.step()` is
 * recorded when it succeeds, so a run that dies mid-flight resumes on a
 * different sandbox by replaying the journal instead of re-doing the work.
 * That is what makes a `ctx.sleep(ONE_DAY_MS)` and a multi-hour batch
 * expressible at all.
 *
 * The execution engine lives in `host/workflow-engine.ts`; nothing here
 * imports it, so an agent bundle that declares workflows pays no host cost
 * until one runs. See `packages/aai/CLAUDE.md` ("Durable workflows") for the
 * semantics an author has to know — above all that steps are AT-LEAST-ONCE.
 */

import type { Db } from "./db.ts";
import type { GenerateFn } from "./generate.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
// Imported as well as re-exported below: a re-export does not bring the name into
// this module's scope, and `WorkflowClient`'s signatures need it.
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/**
 * Default attempts for one {@link WorkflowContext.step} before the run fails.
 *
 * Three rather than one because the failures a step sees are overwhelmingly
 * transient (a provider 503, a pooler hiccup), and rather than unbounded
 * because a step that fails deterministically should surface as a failed run
 * an author can read, not as a retry loop that bills forever.
 */
export const DEFAULT_STEP_MAX_ATTEMPTS = 3;

/** Base delay for the exponential backoff between step attempts (ms). */
export const DEFAULT_STEP_BACKOFF_MS = 500;

/**
 * Steps one run may journal before it is failed deliberately.
 *
 * A hard cap rather than a soft one, because the failure it prevents is
 * silent: replay reads the journal back through `ctx.db`, which throws past
 * {@link MAX_DB_RESULT_ROWS} rows, and a journal that could not be read in
 * full would look like a run with no history — i.e. every completed step
 * would run a second time. A workflow that needs more iterations than this
 * should fan out into child runs rather than one long journal.
 */
export const MAX_WORKFLOW_STEPS = 500;

/** Runs {@link WorkflowClient.find} returns when the caller names no limit. */
export const DEFAULT_WORKFLOW_FIND_LIMIT = 10;

/**
 * Ceiling on {@link WorkflowClient.find}'s limit.
 *
 * The same reasoning as {@link MAX_WORKFLOW_STEPS}: the read goes through
 * `ctx.db`, which throws past `MAX_DB_RESULT_ROWS`, and a `find` that threw
 * would take out the tool call asking "is my thing ready yet?" rather than
 * answering it.
 */
export const MAX_WORKFLOW_FIND_LIMIT = 100;

/**
 * Error text a `ctx.workflows` call rejects with when the app has no engine —
 * no workflows declared, or storage disabled so the journal has nowhere to
 * live. One string so `aai dev` and the platform read identically, exactly
 * like {@link STORAGE_DISABLED_MESSAGE}.
 */
export const WORKFLOWS_UNAVAILABLE_MESSAGE =
  "No workflow engine is available for this app. Declare workflows with " +
  "`agent({ workflows })`, and enable storage with `aai storage enable` (or set " +
  "DATABASE_URL in the project .env under `aai dev`) — the run journal requires it.";

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

/** Per-step overrides for {@link WorkflowContext.step}. */
export type StepOptions = {
  /** Attempts before the step gives up and fails the run. Defaults to {@link DEFAULT_STEP_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Base backoff between attempts, doubled each time. Defaults to {@link DEFAULT_STEP_BACKOFF_MS}. */
  backoffMs?: number;
};

/**
 * The journal's value contract — {@link Journalable} (the type) and
 * {@link findUnjournalable} (the runtime check the engine runs on every step
 * output). Re-exported here because `ctx.step` is where an author meets them.
 */
export { findUnjournalable, type Journalable } from "./journalable.ts";

/**
 * What a workflow's `run` receives — the same capabilities a tool's `execute`
 * gets (`env`, `db`, `generate`), plus the two that make it durable.
 *
 * @public
 */
export type WorkflowContext = {
  /**
   * Environment variables for this app, exactly as `ctx.env` in a tool.
   * Names a workflow depends on belong in `agent({ requiredEnv })` so a
   * missing value fails at deploy time rather than mid-run.
   */
  env: Readonly<Record<string, string>>;
  /**
   * The app's SQL database. Always available inside a workflow: the journal
   * that makes the run durable lives here, so a run cannot exist without it
   * (unlike `ctx.db` in a tool, which throws when storage is off).
   */
  db: Db;
  /** One-shot LLM generation, identical to `ctx.generate` in a tool. */
  generate: GenerateFn;
  /** This run's id — the same value {@link WorkflowClient.start} resolved with. */
  runId: string;
  /**
   * Aborts when the host is shutting down, and when the run is CANCELLED
   * ({@link WorkflowClient.cancel}) while this process is executing it. A long
   * step should pass it to `fetch` so neither a drain nor a cancel waits out
   * the full attempt; a drained run resumes from the last recorded step, so
   * abandoning work here is safe either way.
   */
  signal: AbortSignal;
  /**
   * Run `fn` once per run and journal its result.
   *
   * On replay a completed step does not re-execute — its recorded output is
   * returned instead. `name` identifies the step, and a name reused inside a
   * loop is disambiguated by call order, so
   * `for (const x of xs) await ctx.step("fetch", …)` journals one entry per
   * iteration. What that costs is DETERMINISM: the sequence of `step` calls
   * must not vary between replays of one run, so branch on values that came
   * out of a step (or out of the input), never on `Date.now()` or `Math.random()`
   * read directly in the workflow body. A run whose sequence DID change is
   * reported — the engine logs the journaled steps a replay never re-claimed —
   * but the report arrives after the fact, so the rule is still the author's.
   *
   * Steps are **at-least-once**. A crash between `fn` returning and the
   * journal write means `fn` runs again on resume, so a step with an external
   * side effect wants an idempotency key — pass the `runId` plus the step
   * name to the provider that accepts one.
   *
   * The result must survive the journal's jsonb round trip. That is CHECKED —
   * {@link findUnjournalable} runs on every output before it is journaled, so a
   * step returning a `Date`, `Map`, `Set`, `RegExp`, `bigint`, `symbol` or a
   * method fails the run on its first execution with the property path named,
   * rather than quietly returning something else on the resume. Return the JSON
   * form (an ISO string, an array of entries) and rebuild outside the step;
   * `satisfies Journalable<T>` gets the same check at compile time.
   *
   * @example
   * ```ts
   * import type { WorkflowContext } from "@alexkroman1/aai";
   * declare const ctx: WorkflowContext; // the context a workflow's run receives
   * declare const month: string;
   *
   * const rows = await ctx.step("fetch-invoices", () =>
   *   ctx.db.query("select * from invoices where month = $1", [month]),
   * );
   * ```
   */
  step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;
  /**
   * Read bytes a caller uploaded through the workflow API's `/workflows/blobs`
   * route, by the id the run's input named. Resolves `undefined` when the id is
   * unknown or the blob has already been released or swept.
   *
   * This is the counterpart to that upload, and the pair exists because of what
   * a journal is: `step` outputs and the run input are re-read on EVERY replay,
   * so bytes must not travel in them. A page uploads first, starts the run
   * naming the blob, and the run reads it here — so the audio or document is
   * fetched once per step that needs it and never enters the journal.
   *
   * Call it INSIDE a step only when the bytes are what the step works on; the
   * returned value must not itself be returned from the step (see above).
   *
   * `bytes` owns its `ArrayBuffer` exclusively, so it can be handed straight to
   * a `fetch` body, a `Blob` part or a `FormData` entry — no `new
   * Uint8Array(...)` re-copy, which is what a pooled Node `Buffer` would
   * otherwise force on every caller.
   *
   * @example
   * ```ts
   * import type { WorkflowContext } from "@alexkroman1/aai";
   * declare const ctx: WorkflowContext;
   * declare const blobId: string;
   *
   * const text = await ctx.step("transcribe", async () => {
   *   const audio = await ctx.blob(blobId);
   *   if (!audio) throw new Error(`upload ${blobId} is gone`);
   *   return audio.bytes.byteLength; // …send it somewhere, journal the RESULT
   * });
   * ```
   */
  blob(
    blobId: string,
  ): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> } | undefined>;
  /**
   * Delete an uploaded blob now that the run is done with it.
   *
   * Optional housekeeping, not a correctness requirement — every blob is swept
   * on age anyway. Worth doing when the bytes are a user's own recording or
   * document: the sweep's window is sized for a run that sleeps for hours, which
   * is far longer than a finished run has any reason to keep them.
   *
   * Resolves whether anything was deleted, so a replay of the same step (which
   * finds it already gone) is not an error.
   */
  releaseBlob(blobId: string): Promise<boolean>;
  /**
   * Suspend the run for `ms`, durably.
   *
   * Unlike a `setTimeout`, this does not hold a process open: the wake time
   * is journaled, the run is released, and it is picked up again when due —
   * possibly on another sandbox, possibly days later. The call therefore
   * never returns on the replay that schedules it; treat everything after it
   * as running in a later life of the run.
   */
  sleep(ms: number): Promise<void>;
};

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
