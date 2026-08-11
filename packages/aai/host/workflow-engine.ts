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
import { formatSchemaIssues } from "../sdk/schema.ts";
import { errorMessage } from "../sdk/utils.ts";
import {
  DEFAULT_STEP_BACKOFF_MS,
  DEFAULT_STEP_MAX_ATTEMPTS,
  MAX_WORKFLOW_STEPS,
  type StepOptions,
  type WorkflowClient,
  type WorkflowContext,
  type WorkflowDef,
  type WorkflowRunSnapshot,
  type WorkflowSummary,
} from "../sdk/workflow.ts";
import { type HostGenerateFn, toGenerateFn } from "./generate.ts";
import type { Logger } from "./runtime-config.ts";
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

/**
 * Thrown by `ctx.sleep()` to unwind a run that has more to do later.
 *
 * A class rather than a sentinel value so it cannot be confused with an
 * author's own error, and NOT exported: an author who catches it around a
 * `sleep` would silently convert a suspension into a completed run, so the
 * only code that can recognize it is in this file.
 */
class Suspended extends Error {
  /** Epoch ms the run becomes due again. Declared as a field rather than a
   *  constructor parameter property, which `erasableSyntaxOnly` forbids. */
  readonly wakeAt: number;

  constructor(wakeAt: number) {
    super("workflow suspended");
    this.name = "Suspended";
    this.wakeAt = wakeAt;
  }
}

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
   * Store bytes for a run to work on and resolve the id that names them — see
   * {@link WorkflowStore.putBlob} for why they may not ride the journal.
   *
   * Reached from the workflow HTTP API, which is the only caller that has
   * bytes and no `ctx.db`: code inside the app writes its own rows.
   */
  putBlob(contentType: string, base64: string): Promise<string>;
  /**
   * The workflows this engine can run, name + description — what
   * `GET /workflows` serves and what a static page's client-config carries.
   *
   * On the engine rather than read off the agent def by each caller, so the
   * HTTP API and `createServer` cannot disagree about what this app offers.
   */
  listing(): WorkflowSummary[];
  /**
   * Stop: abort in-flight runs' `ctx.signal` and cancel pending wake timers.
   * Journaled state is untouched — an abandoned run resumes once its lease
   * expires, which is what makes a redeploy safe mid-run.
   */
  close(): void;
};

/**
 * The error a step raises once it is out of attempts.
 *
 * A shutdown mid-step is not a step failure: the run keeps its journal and
 * resumes from where it stopped, so the message says so rather than blaming the
 * step — and `execute` reads the same signal to leave the run claimable.
 */
function stepFailure(stepId: string, maxAttempts: number, cause: unknown, aborted: boolean): Error {
  if (aborted) {
    return new Error(`workflow step "${stepId}" abandoned: host is shutting down`);
  }
  return new Error(
    `workflow step "${stepId}" failed after ${maxAttempts} attempt(s): ${errorMessage(cause)}`,
    { cause },
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

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
  let initialized: Promise<void> | undefined;

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

  /** Run one step's function, retrying transient failures with backoff. */
  async function attempt<T>(
    stepId: string,
    fn: () => Promise<T> | T,
    options: StepOptions | undefined,
    signal: AbortSignal,
  ): Promise<T> {
    const maxAttempts = options?.maxAttempts ?? DEFAULT_STEP_MAX_ATTEMPTS;
    const backoffMs = options?.backoffMs ?? DEFAULT_STEP_BACKOFF_MS;
    let last: unknown;
    for (let n = 1; n <= maxAttempts; n++) {
      if (signal.aborted) break;
      try {
        return await fn();
      } catch (err) {
        last = err;
        logger.error(`workflow step "${stepId}" attempt ${n}/${maxAttempts} failed`, {
          error: errorMessage(err),
        });
        if (n < maxAttempts) await delay(backoffMs * 2 ** (n - 1), signal);
      }
    }
    throw stepFailure(stepId, maxAttempts, last, signal.aborted);
  }

  /** Build the context one execution of one run sees. */
  function buildContext(
    runId: string,
    journal: Map<string, unknown>,
    signal: AbortSignal,
  ): WorkflowContext {
    // Per-name call counters, so a step name reused in a loop yields one
    // journal entry per iteration rather than replaying the first forever.
    // Prefixed by kind (`s:` author step, `t:` timer) so a `sleep` can never
    // collide with a step an author happened to name the same thing.
    const ordinals = new Map<string, number>();
    const nextId = (kind: "s" | "t", name: string): string => {
      const key = `${kind}:${name}`;
      const n = ordinals.get(key) ?? 0;
      ordinals.set(key, n + 1);
      return `${key}#${n}`;
    };

    /**
     * Journal one entry and enforce the run's step cap.
     *
     * BOTH `step` and `sleep` go through here, because the cap is about the
     * journal's SIZE rather than about author steps: replay reads every row
     * back through `ctx.db`, so a run that sleeps in a loop overruns
     * `MAX_DB_RESULT_ROWS` exactly as a run that steps in a loop does — and a
     * journal that cannot be read in full replays as a run with no history.
     */
    const record = async (stepId: string, output: unknown): Promise<void> => {
      const count = await store.recordStep(runId, stepId, output);
      journal.set(stepId, output);
      if (count >= MAX_WORKFLOW_STEPS) {
        throw new Error(
          `workflow run ${runId} exceeded ${MAX_WORKFLOW_STEPS} journal entries; ` +
            "split the work into child runs",
        );
      }
    };

    return {
      env,
      db,
      generate: toGenerateFn(generate, { signal }),
      runId,
      signal,
      async blob(
        blobId: string,
      ): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> } | undefined> {
        const stored = await store.getBlob(blobId);
        if (!stored) return;
        return {
          contentType: stored.contentType,
          // `new Uint8Array(buf)`, not `Uint8Array.from(buf)`: the latter goes
          // through the iterator path element by element. The copy itself is
          // NOT redundant — `Buffer.from(str, "base64")` may allocate out of
          // Node's shared pool, so its `.buffer` is other buffers' too, and
          // exclusive ownership is what lets this be typed `Uint8Array<
          // ArrayBuffer>` and handed to a `fetch` body or a `Blob` without the
          // caller re-copying it (see `WorkflowContext.blob`).
          bytes: new Uint8Array(Buffer.from(stored.base64, "base64")),
        };
      },

      releaseBlob(blobId: string): Promise<boolean> {
        return store.deleteBlob(blobId);
      },

      async step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T> {
        const stepId = nextId("s", name);
        // Replay: a journaled step is a fact, and re-running it is exactly
        // what durability is supposed to prevent.
        if (journal.has(stepId)) return journal.get(stepId) as T;
        const output = await attempt(stepId, fn, options, signal);
        await record(stepId, output);
        return output;
      },
      async sleep(ms: number): Promise<void> {
        const stepId = nextId("t", "sleep");
        const journaled = journal.get(stepId);
        // Already scheduled on an earlier life of this run: either the wake
        // time has passed (fall through and keep going) or it has not (suspend
        // again, without moving the deadline — a resumed run must not have its
        // sleep extended by however long it waited to be picked up).
        if (typeof journaled === "number") {
          if (Date.now() >= journaled) return;
          throw new Suspended(journaled);
        }
        const wakeAt = Date.now() + Math.max(0, ms);
        await record(stepId, wakeAt);
        throw new Suspended(wakeAt);
      },
    };
  }

  /**
   * Claim a run and execute it to its next boundary — completion, failure, or
   * suspension. A run this process cannot claim is someone else's; returning
   * quietly is the correct outcome, not an error.
   */
  async function execute(runId: string): Promise<void> {
    if (inFlight.has(runId) || shutdown.aborted) return;
    inFlight.add(runId);
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
      const ctx = buildContext(runId, journal, shutdown);
      // The journal hands back `unknown` — it stores whatever jsonb round-trip
      // of the input `start()` validated against this workflow's own schema.
      // Narrowing to the declaration's own parameter type is the assertion
      // that `start()` already made good on.
      const input = claimed.input as Parameters<typeof def.run>[0];
      const output = await def.run(input, ctx);
      await store.complete(runId, output);
    } catch (err) {
      await settleFailure(runId, err);
    } finally {
      inFlight.delete(runId);
    }
  }

  /**
   * Record how an execution that did not complete ended. Three outcomes, and
   * only one of them is a failed run.
   */
  async function settleFailure(runId: string, err: unknown): Promise<void> {
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
    async start(name: string, input?: unknown): Promise<string> {
      const def = workflows[name];
      if (!def) {
        const known = Object.keys(workflows);
        throw new Error(
          `Unknown workflow "${name}". Declared workflows: ${known.length > 0 ? known.join(", ") : "none"}`,
        );
      }
      const validated = await validate(name, def, input);
      await ensureTables();
      const runId = crypto.randomUUID();
      await store.create(runId, name, validated);
      // Deliberately not awaited — `start` resolves as soon as the run is
      // durable, which is the whole point: the caller is a tool answering a
      // turn, and the run outlives it. Failures are journaled by `execute`,
      // so the catch here is only for a rejection it could not record.
      void execute(runId).catch((err: unknown) => {
        logger.error(`workflow run ${runId} could not start`, { error: errorMessage(err) });
      });
      return runId;
    },

    async get(runId: string): Promise<WorkflowRunSnapshot | undefined> {
      await ensureTables();
      return store.get(runId);
    },

    async putBlob(contentType: string, base64: string): Promise<string> {
      await ensureTables();
      const blobId = crypto.randomUUID();
      await store.putBlob(blobId, contentType, base64);
      return blobId;
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
