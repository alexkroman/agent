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
 * ## What this is NOT
 *
 * Durable across a restart. The runs live in whatever journal it is handed, and
 * the timers live in this process — so a `ctx.sleep` in flight when the process
 * exits is forgotten along with the run. That is the honest trade for `aai dev`
 * and it is the same one the DevKit's local world made; a deployed guest needs
 * the platform's queue and journal instead, which is why `dispatch` is a
 * parameter of the engine rather than something it decides.
 */

import { randomUUID } from "node:crypto";
import type { WorkflowDef } from "@alexkroman1/aai";
import type { Logger } from "./runtime-config.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
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

/** What {@link createInProcessWorkflowEngine} takes. */
export type InProcessWorkflowEngineOptions = {
  workflows: Readonly<Record<string, WorkflowDef>>;
  logger: Logger;
  /** Defaults to a fresh in-memory journal. Injected so a spec can inspect one. */
  journal?: JournalStore;
  /** Defaults to a fresh in-memory progress store. */
  streams?: StreamStore;
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
      logger.error?.("Workflow delivery failed", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
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
    dispatch: schedule,
    // `wrun_` + a uuid. Not sortable, and it does not need to be: `listRuns`
    // orders by `createdAt` with the id only breaking a tie, so what the id owes
    // is uniqueness and the grammar `_workflow-run-id.ts` will accept.
    newRunId: () => `wrun_${randomUUID().replaceAll("-", "")}`,
    logger,
  });

  return {
    ...engine,
    stop(): void {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
