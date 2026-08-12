// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow executor — replay, retry, suspension, recovery.
 *
 * A run is executed by calling the author's `run` function FROM THE TOP every
 * time, with `ctx.step()` short-circuiting to the journaled output of any step
 * that already succeeded. So the same code path both starts a run and resumes
 * one; there is no separate resume routine to drift from the first-run path,
 * which is the property the whole design is bought for.
 *
 * `ctx.sleep()` is the other half: it journals a wake time and then THROWS a
 * private suspension, unwinding the run function without completing it. The
 * run is released, picked up when due (by the wake timer here, or by
 * `runDue()` in a later process), and replays to the same `sleep` call — which
 * now finds its wake time already past and returns normally.
 *
 * What this deliberately does NOT do is keep the process alive for a sleeping
 * run. A wake timer only fires while this host lives; anything longer than
 * {@link MAX_WAKE_TIMER_MS} — or anything at all after the sandbox exits — is
 * recovered by `runDue()` on the next boot. Waking an idle sandbox to serve a
 * due run is the platform's job and is not wired yet; see "Durable workflows"
 * in `packages/aai/CLAUDE.md`.
 */

import type { Db } from "../sdk/db.ts";
import type { ToolInputSchema } from "../sdk/schema.ts";
import { formatSchemaIssues } from "../sdk/schema.ts";
import { errorMessage } from "../sdk/utils.ts";
import {
  type AnyWorkflowDef,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  type FindOptions,
  MAX_WORKFLOW_FIND_LIMIT,
  type StartOptions,
  type WorkflowClient,
  type WorkflowDef,
  type WorkflowRunSnapshot,
  type WorkflowSummary,
} from "../sdk/workflow.ts";
import type { HostGenerateFn } from "./generate.ts";
import type { Logger } from "./runtime-config.ts";
import { createContextFactory, reportSequenceDrift, Suspended } from "./workflow-execution.ts";
import type { WorkflowStore } from "./workflow-store.ts";

/**
 * How long a claim is held before another executor may take the run over.
 * Long enough that an ordinary step (an LLM call, an HTTP fetch) cannot
 * outlive it, short enough that a dead sandbox's run is not stranded for long.
 */
export const WORKFLOW_LEASE_MS = 120_000;

/** Longest in-process wake timer; past this, recovery is `runDue()`'s job. */
export const MAX_WAKE_TIMER_MS = 60_000;

/** Runs one `runDue()` sweep may execute, bounding a cold start's fan-out. */
export const MAX_DUE_RUNS = 20;

/**
 * How long an uploaded blob survives without a run consuming it.
 *
 * Sized against the runs, not the upload: a run that sleeps between steps can
 * legitimately take hours to reach the blob it was started with, so anything
 * shorter would delete an input out from under a live run. What it reclaims is
 * the upload nothing ever started — a closed tab, a failed `start()` — which is
 * referenced by nothing and would otherwise sit in the app's schema forever.
 */
export const WORKFLOW_BLOB_TTL_MS = 24 * 60 * 60 * 1000;

/** Everything the engine needs to execute a run. */
export type WorkflowEngineOptions = {
  /** The agent's declared workflows, keyed by name. */
  workflows: Readonly<Record<string, WorkflowDef>>;
  store: WorkflowStore;
  /** Becomes `ctx.db` inside a workflow. */
  db: Db;
  /** Becomes `ctx.env` inside a workflow. */
  env: Readonly<Record<string, string>>;
  /**
   * Host generation, bound to the engine's own shutdown signal here rather
   * than by the caller — so a drain cancels an in-flight `ctx.generate` for
   * the same reason it abandons the step around it.
   */
  generate: HostGenerateFn | undefined;
  logger: Logger;
};

/**
 * The engine: a {@link WorkflowClient} (what tool code sees as
 * `ctx.workflows`) plus the two lifecycle entry points the runtime drives.
 *
 * @internal
 */
export type WorkflowEngine = WorkflowClient & {
  /**
   * Execute every run that is due now — due sleepers, runs never picked up,
   * and runs whose executor died holding a lease. This is cold-start recovery;
   * the runtime calls it once on boot.
   */
  runDue(): Promise<number>;
  /**
   * Is there durable work in flight, or about to be?
   *
   * True while a run is executing here, and while a near-term wake timer is
   * armed (a `ctx.sleep` inside {@link MAX_WAKE_TIMER_MS}). It exists for one
   * caller: the guest's idle-exit controller, which otherwise measures
   * "does anybody need me" as the live SESSION count — and a static-page app
   * has no sessions by construction, so a five-minute timer was killing
   * healthy long runs and then paying the lease to recover them.
   *
   * Deliberately NOT true for a long sleeper. Holding a billed container open
   * for a six-hour `ctx.sleep` is the thing `sleep` releases the run to avoid;
   * that case wants an external wake, not a pinned sandbox.
   */
  busy(): boolean;
  /**
   * Store bytes for a run to work on and resolve the id that names them — see
   * {@link WorkflowStore.putBlob} for why they may not ride the journal.
   *
   * Reached from the workflow HTTP API, which is the only caller that has
   * bytes and no `ctx.db`: code inside the app writes its own rows.
   */
  putBlob(contentType: string, base64: string): Promise<string>;
  /**
   * Stop: abort in-flight runs' `ctx.signal` and cancel pending wake timers.
   * Journaled state is untouched — an abandoned run resumes once its lease
   * expires, which is what makes a redeploy safe mid-run.
   */
  close(): void;
};

/**
 * Create the workflow engine for one runtime.
 *
 * @internal
 */
export function createWorkflowEngine(opts: WorkflowEngineOptions): WorkflowEngine {
  const { workflows, store, db, env, generate, logger } = opts;
  const shutdownController = new AbortController();
  const shutdown = shutdownController.signal;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** Runs this process is already executing — saves a pointless claim attempt. */
  const inFlight = new Set<string>();
  /**
   * Abort handles for those executions, so `cancel` can stop one PROMPTLY here.
   * A run in flight on another replica has no such handle and stops at its next
   * terminal write instead, which the store refuses — see `WorkflowClient.cancel`.
   */
  const controllers = new Map<string, AbortController>();
  let initialized: Promise<void> | undefined;
  // Built once per engine: the per-run machinery lives in `workflow-execution.ts`
  // and takes the engine's dependencies here rather than closing over them.
  const buildContext = createContextFactory({ store, db, env, generate, logger });

  /**
   * Declared name(s) for each workflow OBJECT, so a caller can pass the
   * workflow itself instead of a string.
   *
   * `agent({ workflows })` stays the single source of the name the journal
   * records — this is only the reverse direction of that same record, which is
   * what keeps a rename a one-place edit. Built once per engine because the
   * record is fixed for the life of a bundle.
   */
  const namesOf = new Map<WorkflowDef, string[]>();
  for (const [name, def] of Object.entries(workflows)) {
    const existing = namesOf.get(def);
    if (existing) existing.push(name);
    else namesOf.set(def, [name]);
  }

  /** The declared names, for an error message that can be acted on. */
  function declaredNames(): string {
    const known = Object.keys(workflows);
    return known.length > 0 ? known.join(", ") : "none";
  }

  /**
   * Resolve `start`/`find`'s first argument to a declared workflow name.
   *
   * Both spellings fail at the same boundary and say the same kind of thing: a
   * name that is not declared, or a def that is not in the record (an author who
   * built a workflow and forgot to declare it — the one mistake the typed
   * overload cannot catch, since nothing links a bare `workflow()` result to an
   * agent).
   */
  function resolveName(workflow: WorkflowDef | string): string {
    if (typeof workflow === "string") {
      if (!workflows[workflow]) {
        throw new Error(`Unknown workflow "${workflow}". Declared workflows: ${declaredNames()}`);
      }
      return workflow;
    }
    const names = namesOf.get(workflow);
    if (names === undefined || names[0] === undefined) {
      throw new Error(
        "This workflow is not declared on this agent — add it to `agent({ workflows })`. " +
          `Declared workflows: ${declaredNames()}`,
      );
    }
    // Two keys pointing at one object: the journal records ONE name, and picking
    // either would make which one arbitrary. The author has to say.
    if (names.length > 1) {
      throw new Error(
        `This workflow is declared under ${names.length} names (${names.join(", ")}). ` +
          "Start it by name so the journal records which one, or declare it once.",
      );
    }
    return names[0];
  }

  /** Create the journal tables once per engine, and only if a workflow is used. */
  function ensureTables(): Promise<void> {
    initialized ??= store.init();
    return initialized;
  }

  /** Re-enter `execute` when a sleeping run comes due, if it is soon enough. */
  function scheduleWake(runId: string, wakeAt: number): void {
    const wait = wakeAt - Date.now();
    if (wait > MAX_WAKE_TIMER_MS || shutdown.aborted) return;
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        void execute(runId);
      },
      Math.max(0, wait),
    );
    // Unref'd: a sleeping run must not be the reason a process stays alive.
    // Whether the host lives long enough to fire it is the host's business,
    // and `runDue()` is what makes the missed case recoverable.
    timer.unref?.();
    timers.add(timer);
  }

  /**
   * Claim a run and execute it to its next boundary — completion, failure, or
   * suspension. A run this process cannot claim is someone else's; returning
   * quietly is the correct outcome, not an error.
   */
  async function execute(runId: string): Promise<void> {
    if (inFlight.has(runId) || shutdown.aborted) return;
    inFlight.add(runId);
    // Per-run, so `cancel` can reach exactly this execution. Combined with the
    // engine's shutdown signal rather than replacing it: a drain still abandons
    // every run, and a cancel abandons one, and the workflow body sees both
    // through the same `ctx.signal`.
    const runController = new AbortController();
    controllers.set(runId, runController);
    const signal = AbortSignal.any([shutdown, runController.signal]);
    try {
      const claimed = await store.claim(runId, WORKFLOW_LEASE_MS);
      if (!claimed) return;
      const def = workflows[claimed.workflow];
      if (!def) {
        // The bundle that declared this workflow is not the bundle running it —
        // a redeploy that removed or renamed it. Fail loudly: the run can never
        // make progress, and leaving it claimable is an infinite retry.
        await store.fail(runId, `unknown workflow "${claimed.workflow}"`);
        return;
      }
      const journal = await store.completedSteps(runId);
      const { ctx, claimedSteps } = buildContext(runId, journal, signal);
      // The journal hands back `unknown` — it stores whatever jsonb round-trip
      // of the input `start()` validated against this workflow's own schema.
      // Narrowing to the declaration's own parameter type is the assertion
      // that `start()` already made good on.
      const input = claimed.input as Parameters<typeof def.run>[0];
      try {
        const output = await def.run(input, ctx);
        await store.complete(runId, output);
      } finally {
        // In a `finally` so the check covers every way out — completed, failed,
        // and suspended — since a drifting sequence is not specific to any of
        // them. Runs before the outer catch settles the run.
        reportSequenceDrift(logger, claimed.workflow, runId, journal, claimedSteps);
      }
    } catch (err) {
      await settleFailure(runId, err, runController.signal.aborted);
    } finally {
      inFlight.delete(runId);
      controllers.delete(runId);
    }
  }

  /**
   * Record how an execution that did not complete ended. Four outcomes, and
   * only one of them is a failed run.
   */
  async function settleFailure(runId: string, err: unknown, cancelled: boolean): Promise<void> {
    // Suspended: more to do later, at a time already journaled.
    if (err instanceof Suspended) {
      await store.suspend(runId, err.wakeAt);
      scheduleWake(runId, err.wakeAt);
      return;
    }
    // Abandoned by a drain, not failed by its own code. Leave the run
    // `running` with its journal intact: the lease expires, `due()` reports it,
    // and the next host resumes from the last recorded step. Marking it failed
    // here would turn every redeploy into a graveyard of runs that were one
    // step from finishing.
    if (shutdown.aborted) {
      logger.error(`workflow run ${runId} abandoned mid-step; will resume after lease expiry`);
      return;
    }
    // Cancelled: the store already holds the terminal status, and whatever the
    // body threw on its way out of an aborted step is a CONSEQUENCE of the
    // cancel rather than a failure worth recording over it. Writing `failed`
    // here would also lose the distinction a caller asked for by cancelling.
    if (cancelled) {
      logger.error(`workflow run ${runId} cancelled mid-step`);
      return;
    }
    const message = errorMessage(err);
    logger.error(`workflow run ${runId} failed`, { error: message });
    await store.fail(runId, message);
  }

  /** Validate `input` against the workflow's schema, if it declared one. */
  async function validate(name: string, def: WorkflowDef, input: unknown): Promise<unknown> {
    if (!def.input) return input;
    const parsed = await def.input["~standard"].validate(input ?? {});
    if (parsed.issues) {
      throw new Error(`Invalid input for workflow "${name}": ${formatSchemaIssues(parsed.issues)}`);
    }
    return parsed.value;
  }

  return {
    async start<P extends ToolInputSchema, R>(
      workflow: WorkflowDef<P, R> | string,
      input?: unknown,
      options?: StartOptions,
    ): Promise<string> {
      const name = resolveName(workflow as WorkflowDef | string);
      // Non-null: `resolveName` only returns a name the record holds.
      const def = workflows[name] as WorkflowDef;
      const validated = await validate(name, def, input);
      await ensureTables();
      const runId = crypto.randomUUID();
      await store.create(runId, name, validated, options?.key);
      // Deliberately not awaited — `start` resolves as soon as the run is
      // durable, which is the whole point: the caller is a tool answering a
      // turn, and the run outlives it. Failures are journaled by `execute`,
      // so the catch here is only for a rejection it could not record.
      void execute(runId).catch((err: unknown) => {
        logger.error(`workflow run ${runId} could not start`, { error: errorMessage(err) });
      });
      return runId;
    },

    // `_of` is type-only: it exists so `output` on a completed run is the
    // workflow's own return type rather than `unknown`. The run's stored row is
    // what says which workflow it belongs to, so nothing reads the argument.
    async get<R>(
      runId: string,
      _of?: AnyWorkflowDef<R>,
    ): Promise<WorkflowRunSnapshot<R> | undefined> {
      await ensureTables();
      return (await store.get(runId)) as WorkflowRunSnapshot<R> | undefined;
    },

    async find<R>(
      workflow: AnyWorkflowDef<R> | string,
      key: string,
      options?: FindOptions,
    ): Promise<WorkflowRunSnapshot<R>[]> {
      const name = resolveName(workflow as WorkflowDef | string);
      await ensureTables();
      // Clamped rather than validated: this is reached from tool code answering
      // "is my thing ready yet?", and a caller's stray 10_000 should cost the
      // ceiling instead of failing the turn. The ceiling itself is what keeps the
      // read under `MAX_DB_RESULT_ROWS`.
      const requested = options?.limit ?? DEFAULT_WORKFLOW_FIND_LIMIT;
      const limit = Math.min(Math.max(1, Math.floor(requested)), MAX_WORKFLOW_FIND_LIMIT);
      return (await store.findByKey(name, key, limit)) as WorkflowRunSnapshot<R>[];
    },

    async cancel(runId: string): Promise<boolean> {
      await ensureTables();
      const stopped = await store.cancel(runId);
      // Aborted unconditionally, not only when this call is what stopped it:
      // another replica may have cancelled the run, and this process holds the
      // only handle that can reach its `ctx.signal`.
      controllers.get(runId)?.abort();
      return stopped;
    },

    async putBlob(contentType: string, base64: string): Promise<string> {
      await ensureTables();
      const blobId = crypto.randomUUID();
      await store.putBlob(blobId, contentType, base64);
      return blobId;
    },

    busy(): boolean {
      // `timers` holds only armed wake timers (`scheduleWake`), and a step
      // retrying its backoff is inside `execute`, so `inFlight` covers it.
      return inFlight.size > 0 || timers.size > 0;
    },

    listing(): WorkflowSummary[] {
      return Object.entries(workflows).map(([name, def]) =>
        def.description === undefined ? { name } : { name, description: def.description },
      );
    },

    async runDue(): Promise<number> {
      if (Object.keys(workflows).length === 0) return 0;
      await ensureTables();
      const ids = await store.due(MAX_DUE_RUNS);
      // Abandoned uploads are swept here rather than on a timer of their own:
      // boot is already the moment this engine reconciles what the last life of
      // the app left behind, and a sweep that only runs on a timer never runs
      // at all in a sandbox that idle-exits between runs. Failure is logged and
      // dropped — recovery is the job, and leaked bytes must not prevent it.
      await store.pruneBlobs(WORKFLOW_BLOB_TTL_MS).catch((err: unknown) => {
        logger.error("workflow blob prune failed", { error: errorMessage(err) });
      });
      // Sequential: a cold start recovering a backlog should not open a
      // connection per run against a pool of four.
      for (const id of ids) await execute(id);
      return ids.length;
    },

    close(): void {
      shutdownController.abort();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
