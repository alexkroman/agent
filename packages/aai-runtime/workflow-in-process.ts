// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine, wired to run its own deliveries in THIS process.
 *
 * `createWorkflowEngine` deliberately separates starting a run from executing
 * one — that is what lets one engine serve `aai dev`, a self-hosted server and a
 * deployed guest without knowing which it is in. This is the simplest of the
 * three dispatchers: the run is executed here, on the next turn of the loop.
 *
 * ## Why the engine and the dispatcher are mutually recursive
 *
 * `dispatch` has to reach `execute`, and `execute` belongs to the engine
 * `dispatch` is being passed to. A late-bound `let` is the whole of the trick,
 * and it is safe because `dispatch` is never called during construction: the
 * earliest possible call is from a `start`, which needs a caller.
 *
 * ## A delivery is FIRE-AND-FORGET, and that is the contract
 *
 * `WorkflowEngineOptions.dispatch` returns nothing on purpose — a caller of
 * `ctx.workflows.start` is told the run's id and nothing about its progress, and
 * awaiting the whole run inside a tool call would turn a durable workflow back
 * into a slow request. So the promise is dropped, and a rejection is LOGGED
 * rather than lost: `execute` resolves a status for an ordinary failure, so
 * anything that rejects here is the journal itself being unreachable, which an
 * operator needs to see.
 *
 * ## The timers die with the process, so the JOURNAL is re-read at boot
 *
 * A `ctx.sleep` journals its deadline durably and arms an unreffed `setTimeout`
 * here. Those are two different lifetimes, and for a long time only the first one
 * was honoured: `stop()` cleared the timers, nothing enumerated the journal, and a
 * run suspended when the process restarted — or when `aai dev` rebuilt its
 * runtime, which is every file save — sat `running` FOREVER with its whole journal
 * intact. `wake` could not rescue it, an elapsed deadline being no wait
 * `wakeSleeps` may stop. So the boot line advertised a durable run store while the
 * only case durability means anything in was unrecoverable.
 *
 * {@link JournalStore.resumableRuns} is what closed it, and the sweep below is the
 * in-process twin of `aai-server/workflow-queue-reconcile.ts`. Three properties:
 *
 * - **It only runs where the SCHEDULE is ours.** A caller that injected a
 *   `dispatch` — a deployed guest, whose schedule is a delayed message in the
 *   platform's queue — gets no sweep: that queue has its own reconcile, and a
 *   second recovery mechanism beside it is a sandbox boot per copy of this package.
 * - **A journal that cannot be enumerated is ANNOUNCED, not assumed away.**
 *   `resumableRuns` is optional, so a host-supplied store may lack it; the warning
 *   is what stops that reading as durability it does not have.
 * - **It cannot stampede.** {@link RESUME_SWEEP_LIMIT} bounds the pass and
 *   {@link RESUME_STAGGER_MS} spreads the OVERDUE deliveries, so 500 runs whose
 *   deadlines all elapsed while the process was down are not 500 replays in one
 *   turn of the loop. A future deadline is simply re-armed at its own time.
 *
 * What is still NOT here is any repetition: this is a BOOT sweep, not a poll. A
 * delivery lost while the process stays up (a journal that was briefly
 * unreachable) waits for the next boot, which is the platform reconcile's grace
 * window traded for not having one.
 */

import { randomUUID } from "node:crypto";
import type { WorkflowDef } from "@alexkroman1/aai";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import {
  isResumableJournal,
  type JournalStore,
  type ResumableJournal,
} from "./workflow-journal-types.ts";
import { createMemoryStreams, type StreamStore } from "./workflow-streams.ts";

/**
 * The longest a scheduled delivery may sit on a timer.
 *
 * A `ctx.sleep` may name any deadline, and `setTimeout` silently fires
 * IMMEDIATELY for a delay over 2^31-1 ms (~24.8 days) — so a run asked to wait a
 * month would wake at once, replay, find its journaled wake time still in the
 * future, and suspend again, in a tight loop for as long as the process lives.
 * Re-arming in chunks is what makes a long wait behave: each expiry is a
 * harmless re-check that either re-arms or delivers.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How many stranded runs one boot sweep may re-enqueue.
 *
 * A bound rather than a pass over everything, for the reason
 * `RECONCILE_MAX_PER_TICK` is one on the platform side: a database this process
 * has been away from for a week can hold any number of overdue runs, and
 * recovering all of them at once is its own outage. Generous — a self-hosted
 * server's whole in-flight set is normally far under this — and the overflow is
 * WARNED about rather than dropped silently, because the sweep does not repeat.
 */
const RESUME_SWEEP_LIMIT = 200;

/**
 * How far apart two OVERDUE deliveries are spread.
 *
 * A run whose deadline elapsed while the process was down is due immediately, and
 * N of them dispatched on one turn is N concurrent replays each reading a journal.
 * `workflow-step-gate.ts` bounds the step BODIES underneath, which is the real
 * backstop; this bounds the read amplification above it. Small enough that the
 * whole bounded pass drains in ~5s.
 */
const RESUME_STAGGER_MS = 25;

/** What {@link createInProcessWorkflowEngine} takes. */
export type InProcessWorkflowEngineOptions = {
  workflows: Readonly<Record<string, WorkflowDef>>;
  logger: Logger;
  /**
   * Where runs live. Defaults to a fresh in-memory journal.
   *
   * `workflow-runtime.ts` passes a Postgres one when the deployment has a
   * `DATABASE_URL`, which is what makes a run outlive its process. A spec passes
   * a memory one it can inspect.
   */
  journal?: JournalStore | undefined;
  /** Defaults to a fresh in-memory progress store. */
  streams?: StreamStore | undefined;
  /**
   * Where a delivery goes. Defaults to a `setTimeout` in this process.
   *
   * A DEPLOYED guest passes `createPlatformDispatch` instead, because its timers
   * die with a sandbox that self-exits after `AGENT_IDLE_EXIT_MS` — see that
   * module for why it REPLACES the local timer rather than racing it.
   *
   * `stop()` still cancels whatever timers this factory created, which for an
   * injected dispatcher is none: what a deployed guest owes on the way down is
   * nothing, the queue holding the schedule.
   */
  dispatch?: ((runId: string, at?: number) => void) | undefined;
};

/** The engine plus the one thing a host must do on the way down. */
export type InProcessWorkflowEngine = WorkflowEngine & {
  /**
   * Cancel every pending delivery.
   *
   * Not optional for a HOST: `aai dev` rebuilds its runtime on every file save,
   * so without this each save leaves the previous engine's timers behind, still
   * holding a journal and still executing bodies from a build that is gone.
   */
  stop(): void;
};

/** What a boot sweep needs, which is deliberately not the whole engine. */
type BootSweep = {
  journal: JournalStore;
  /** The LOCAL dispatcher's own scheduler — never an injected one. */
  schedule: (runId: string, at?: number) => void;
  /** Read late, because `stop()` may land mid-pass. */
  stopped: () => boolean;
  logger: Logger;
};

/**
 * Re-enqueue every run this journal still owes a delivery.
 *
 * Fire-and-forget, like a delivery: `createInProcessWorkflowEngine` is
 * synchronous because `createRuntime` is, and a host must not wait on a journal
 * read to get a server bound. A failure is LOGGED rather than dropped — the whole
 * point is that a run nothing re-enqueues is silent.
 *
 * Overlapping with a walk the PREVIOUS engine still has in flight is safe and is
 * the ordinary case under `aai dev`: `stop()` cancels timers and not walks, and a
 * delivery is at-least-once by design — see `workflow-engine.ts`.
 *
 * Module-level rather than a closure inside the factory, which Biome measured at
 * cognitive complexity 18 with this in it.
 */
async function sweepOnce(sweep: BootSweep, journal: ResumableJournal): Promise<void> {
  const owed = await journal.resumableRuns(RESUME_SWEEP_LIMIT);
  if (owed.length === 0) return;
  const now = Date.now();
  let overdue = 0;
  for (const run of owed) {
    if (sweep.stopped()) return;
    // A deadline still in the future is re-armed AT that deadline; anything due
    // now joins the staggered queue, `overdue` being its position in it.
    const future = run.wakeAt !== undefined && run.wakeAt > now;
    sweep.schedule(run.runId, future ? run.wakeAt : now + overdue++ * RESUME_STAGGER_MS);
  }
  sweep.logger.info?.("Workflow runs re-enqueued at boot", { runs: owed.length, overdue });
  // The sweep does not repeat, so a full pass means runs were left behind and
  // nothing will come back for them until the next boot.
  if (owed.length === RESUME_SWEEP_LIMIT) {
    sweep.logger.warn?.("Workflow boot re-enqueue hit its ceiling", {
      limit: RESUME_SWEEP_LIMIT,
      detail: "runs beyond this pass are not re-enqueued until the next boot",
    });
  }
}

/**
 * Sweep, or say why not.
 *
 * The warning is the half that matters when it fires: `resumableRuns` is optional
 * on {@link JournalStore}, so a host-supplied store may lack it — and a
 * durability tradeoff absent from the log reads as a bug.
 */
function startBootSweep(sweep: BootSweep): void {
  if (!isResumableJournal(sweep.journal)) {
    sweep.logger.warn?.("Workflow runs cannot be recovered at boot", {
      detail:
        "this journal does not enumerate resumable runs — a run suspended on " +
        "ctx.sleep is not re-delivered after a restart or a rebuild",
    });
    return;
  }
  void sweepOnce(sweep, sweep.journal).catch((err: unknown) => {
    sweep.logger.error?.("Workflow boot re-enqueue failed", { error: errorMessage(err) });
  });
}

/**
 * Build an engine that executes its own runs in this process.
 *
 * @internal
 */
export function createInProcessWorkflowEngine(
  options: InProcessWorkflowEngineOptions,
): InProcessWorkflowEngine {
  const { workflows, logger } = options;
  const journal = options.journal ?? createMemoryJournal();
  const streams = options.streams ?? createMemoryStreams();

  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  // Late-bound: see the module doc. Assigned before anything can dispatch.
  let engine: WorkflowEngine | undefined;

  /** Execute one delivery, reporting a journal failure rather than dropping it. */
  function deliver(runId: string): void {
    if (stopped) return;
    // `void` with a catch rather than an async listener — `guard-invariants`
    // rule 23, and the reason it exists: a rejection escaping into the timer
    // callback is an unhandled rejection, which by default ends the process.
    void engine?.execute(runId).catch((err: unknown) => {
      logger.error?.("Workflow delivery failed", { runId, error: errorMessage(err) });
    });
  }

  /**
   * Deliver `runId` now, or at `at`.
   *
   * `setTimeout(0)` rather than a synchronous call even for "now": `dispatch` is
   * called from inside `start`, which is inside a tool's `execute`, and running
   * the whole body there would make a durable start a blocking one.
   */
  function schedule(runId: string, at?: number): void {
    if (stopped) return;
    const delay = at === undefined ? 0 : at - Date.now();
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        // Still in the future, which a clamped timer means rather than an error.
        if (at !== undefined && at - Date.now() > 0) schedule(runId, at);
        else deliver(runId);
      },
      Math.min(Math.max(delay, 0), MAX_TIMER_MS),
    );
    // Unreffed, so a pending delivery cannot hold a CLI open. The run is only as
    // durable as the process either way, so keeping it alive to finish a sleep
    // would be a promise this dispatcher cannot make.
    timer.unref();
    timers.add(timer);
  }

  engine = createWorkflowEngine({
    workflows,
    journal,
    streams,
    dispatch: options.dispatch ?? schedule,
    // `wrun_` + a uuid. Not sortable, and it does not need to be: `listRuns`
    // orders by `createdAt` with the id only breaking a tie, so what the id owes
    // is uniqueness and the grammar `_workflow-run-id.ts` will accept.
    newRunId: () => `wrun_${randomUUID().replaceAll("-", "")}`,
    logger,
  });

  // Only where the schedule is OURS — an injected dispatcher owns its own
  // recovery, and the platform's queue reconcile is that recovery.
  if (options.dispatch === undefined) {
    startBootSweep({ journal, schedule, stopped: () => stopped, logger });
  }

  return {
    ...engine,
    stop(): void {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
