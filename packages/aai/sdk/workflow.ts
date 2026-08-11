// Copyright 2026 the AAI authors. MIT license.
/**
 * Durable workflows — the author-facing half.
 *
 * A workflow is work that outlives the session that started it. Where a
 * `tool()` runs inside one turn, on one sandbox, under
 * `TOOL_EXECUTION_TIMEOUT_MS`, a workflow is journaled: each `ctx.step()` is
 * recorded when it succeeds, so a run that dies mid-flight resumes on a
 * different sandbox by replaying the journal instead of re-doing the work.
 * That is what makes `ctx.sleep("until tomorrow")` and a multi-hour batch
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
 * Lifecycle of one workflow run.
 *
 * - `pending` — created, not yet picked up.
 * - `running` — claimed by an executor whose lease has not expired.
 * - `sleeping` — suspended at a {@link WorkflowContext.sleep}; `wakeAt` says when.
 * - `completed` / `failed` — terminal.
 *
 * A `running` run whose lease expired (its sandbox died) is claimable again;
 * that is the whole recovery mechanism, and it is why the status set has no
 * separate "crashed".
 *
 * @public
 */
export type WorkflowRunStatus = "pending" | "running" | "sleeping" | "completed" | "failed";

/** Per-step overrides for {@link WorkflowContext.step}. */
export type StepOptions = {
  /** Attempts before the step gives up and fails the run. Defaults to {@link DEFAULT_STEP_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Base backoff between attempts, doubled each time. Defaults to {@link DEFAULT_STEP_BACKOFF_MS}. */
  backoffMs?: number;
};

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
   * Aborts when the host is shutting down. A long step should pass it to
   * `fetch` so a drain does not wait out the full attempt; the run resumes
   * from the last recorded step afterwards, so abandoning work here is safe.
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
   * read directly in the workflow body.
   *
   * Steps are **at-least-once**. A crash between `fn` returning and the
   * journal write means `fn` runs again on resume, so a step with an external
   * side effect wants an idempotency key — pass the `runId` plus the step
   * name to the provider that accepts one.
   *
   * The result must survive `JSON.stringify` — it is written to the journal
   * as jsonb and read back on the next replay.
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
  blob(blobId: string): Promise<{ contentType: string; bytes: Uint8Array } | undefined>;
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
 *
 * @public
 */
export type WorkflowDef<P extends ToolInputSchema = ToolInputSchema> = {
  /** What this workflow does. Not shown to an LLM — workflows are started by code, not chosen by a model. */
  description?: string;
  /** Schema for the run input, validated at `start()` so a bad payload fails at the call site. */
  input?: P;
  /** The workflow body. Called on every replay, from the top. */
  run(input: InferSchemaOutput<P>, ctx: WorkflowContext): Promise<unknown> | unknown;
};

/**
 * A run's observable state, as {@link WorkflowClient.get} returns it.
 *
 * @public
 */
export type WorkflowRunSnapshot = {
  runId: string;
  /** Key the workflow was declared under in `agent({ workflows })`. */
  workflow: string;
  status: WorkflowRunStatus;
  /** The `run` function's return value. Present only once `status` is `completed`. */
  output?: unknown;
  /** Failure message. Present only once `status` is `failed`. */
  error?: string;
  /** When a `sleeping` run becomes due, as epoch ms. */
  wakeAt?: number;
  /** How many steps this run has journaled — enough to render coarse progress. */
  stepsCompleted: number;
};

/**
 * Start and inspect workflow runs. Reaches tool code as `ctx.workflows`.
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
   * Rejects when the name is not a declared workflow, when the input fails
   * the workflow's schema, or when storage is not enabled for the app.
   */
  start(name: string, input?: unknown): Promise<string>;
  /** Look up a run by id. Resolves `undefined` when no such run exists. */
  get(runId: string): Promise<WorkflowRunSnapshot | undefined>;
};

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
 *         const runId = await ctx.workflows.start("digest", { topic });
 *         return `Working on it — run ${runId}.`;
 *       },
 *     }),
 *   },
 * });
 * ```
 *
 * @public
 */
export function workflow<P extends ToolInputSchema = ToolInputSchema>(
  def: WorkflowDef<P>,
): WorkflowDef<P> {
  return def;
}
