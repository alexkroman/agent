// Copyright 2026 the AAI authors. MIT license.
/**
 * A {@link JournalStore} whose every call is a SCHEDULING POINT, and the log of
 * what went through it.
 *
 * One of four modules behind `workflow-concurrent-delivery.test.ts`, split at
 * the seams that file already had — this is the WIRE,
 * `_workflow-concurrent-harness.ts` drives the deliveries over it,
 * `_workflow-laws-harness.ts` reads the log back as the property's five laws,
 * and `_workflow-reach-harness.ts` counts what the interleaving reached. That
 * test's own doc carries the argument for the whole thing.
 *
 * ## Scheduling the JOURNAL, not `execute`
 *
 * `studio-concurrency-fuzz.test.ts` paid for this lesson and states it: *"the
 * scheduler runs task bodies one at a time to completion, so wrapping the whole
 * function would serialize deploys and make the invariant unfalsifiable — the
 * harness would report success by construction."* Here the equivalent mistake is
 * scheduling `execute`: two deliveries would then run one after the other and
 * every law would hold for the wrong reason.
 *
 * Wrapping the METHODS instead leaves each of them ATOMIC, which is what
 * the contract requires and what the memory journal really is — every body there
 * completes its read-and-write with no `await` between the two, and a scheduled
 * task body runs to completion. What the scheduler gets to choose is the order
 * of the ROUND TRIPS, which is exactly the freedom a real store's latency has.
 *
 * ## Two arms, and what the second one is honestly a model of
 *
 * {@link Arm} `direct` gives each journal call ONE scheduling point (the call
 * yields, the answer comes back). `roundTrip` gives it two — the caller yields
 * again on the response — which is the shape a NETWORK-backed store has and
 * roughly doubles the reachable interleavings per call. It is not a model of
 * Postgres SEMANTICS: `on conflict`, a row count and a unique index are the
 * database's own answers, which is why the real arm is the scenario tier
 * (`journal-conformance-postgres.scenario.test.ts`). The unit tier can reach the
 * ORDERING difference and nothing else, and this says so rather than implying
 * more.
 */

import { TERMINAL_WORKFLOW_STATUSES } from "@alexkroman1/aai/internal";
import type fc from "fast-check";
import type { JournalStore, RunStatus, SleepRecord, StepEntry } from "./workflow-journal-types.ts";

/**
 * How many scheduling points one journal call has — see the module doc.
 */
export type Arm = "direct" | "roundTrip";

/** One journal call, as the log records it. */
export type Ev = {
  /** The call's own index, shared by its call and its answer. */
  i: number;
  kind: "call" | "ret" | "throw";
  method: string;
  /** Which concurrent operation made the call — a delivery, a signaller, a cancel. */
  by: string;
  args?: readonly unknown[] | undefined;
  value?: unknown;
};

/** The op log, plus the two writers the journal wrapper needs. */
export type OpLog = {
  events: Ev[];
  call(method: string, by: string, args: readonly unknown[]): number;
  settle(i: number, kind: "ret" | "throw", method: string, by: string, value: unknown): void;
};

/** A fresh log. */
export function createOpLog(): OpLog {
  const events: Ev[] = [];
  let next = 0;
  return {
    events,
    call(method, by, args) {
      const i = next++;
      events.push({ i, kind: "call", method, by, args });
      return i;
    },
    settle(i, kind, method, by, value) {
      events.push({ i, kind, method, by, value });
    },
  };
}

/** What {@link scheduleJournal} needs. */
export type ScheduleOptions = {
  scheduler: fc.Scheduler;
  log: OpLog;
  arm: Arm;
  /** Which concurrent operation is calling, read at CALL time — see below. */
  by: () => string;
};

/**
 * Wrap every {@link JournalStore} method so the SCHEDULER decides when it runs.
 *
 * `by` is read synchronously at the call, never inside the scheduled body: the
 * body executes in whatever async context released it, so an
 * `AsyncLocalStorage` read from in there would name the driver rather than the
 * delivery. Getting that wrong does not fail — it silently attributes every call
 * to one operation, and the overlap floor then reads zero.
 *
 * Written out method by method rather than looped over `Object.keys`, because a
 * loop cannot keep the signatures: it needs a cast per method, and this
 * package's escape-hatch budget is the wrong place to spend for brevity. A
 * method added to the interface is then a compile error here, which is the right
 * failure — an unwrapped method is a scheduling point the property cannot see.
 */
export function scheduleJournal(inner: JournalStore, options: ScheduleOptions): JournalStore {
  const { scheduler, log, arm, by } = options;
  const wrap = <A extends unknown[], R>(
    method: string,
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    const scheduled = scheduler.scheduleFunction(fn);
    return async (...args: A): Promise<R> => {
      const who = by();
      const i = log.call(method, who, args);
      try {
        const value = await scheduled(...args);
        // The second scheduling point of the `roundTrip` arm: the ANSWER is
        // handed back on a scheduler turn of its own.
        if (arm === "roundTrip") await scheduler.schedule(Promise.resolve(), `${method} answer`);
        log.settle(i, "ret", method, who, value);
        return value;
      } catch (err: unknown) {
        log.settle(i, "throw", method, who, err);
        throw err;
      }
    };
  };
  return {
    createRun: wrap("createRun", (record) => inner.createRun(record)),
    getRun: wrap("getRun", (runId: string) => inner.getRun(runId)),
    listRuns: wrap("listRuns", (workflowKey: string, limit: number) =>
      inner.listRuns(workflowKey, limit),
    ),
    setStatus: wrap(
      "setStatus",
      (
        runId: string,
        next: RunStatus,
        patch?: { output?: unknown; error?: { message: string } },
        expect?: readonly RunStatus[],
      ) => inner.setStatus(runId, next, patch, expect),
    ),
    readSteps: wrap("readSteps", (runId: string) => inner.readSteps(runId)),
    readStep: wrap("readStep", (runId: string, key: string) => inner.readStep(runId, key)),
    readSleeps: wrap("readSleeps", (runId: string) => inner.readSleeps(runId)),
    claimAttempt: wrap(
      "claimAttempt",
      (runId: string, key: string, holder: string, leaseMs: number) =>
        inner.claimAttempt(runId, key, holder, leaseMs),
    ),
    releaseAttempt: wrap("releaseAttempt", (runId: string, key: string, holder: string) =>
      inner.releaseAttempt(runId, key, holder),
    ),
    claimSleep: wrap(
      "claimSleep",
      (
        runId: string,
        key: string,
        wakeAt: number,
        correlationId: string | undefined,
        kind?: SleepRecord["kind"],
      ) => inner.claimSleep(runId, key, wakeAt, correlationId, kind),
    ),
    wakeSleeps: wrap("wakeSleeps", (runId: string, ids: readonly string[] | undefined) =>
      inner.wakeSleeps(runId, ids),
    ),
    claimHook: wrap("claimHook", (runId: string, key: string, token: string) =>
      inner.claimHook(runId, key, token),
    ),
    closeHook: wrap("closeHook", (runId: string, key: string) => inner.closeHook(runId, key)),
    deliverHook: wrap("deliverHook", (token: string, payload: unknown) =>
      inner.deliverHook(token, payload),
    ),
    resumableRuns: wrap("resumableRuns", (limit: number) =>
      inner.resumableRuns ? inner.resumableRuns(limit) : Promise.resolve([]),
    ),
    appendStep: wrap("appendStep", (runId: string, entry: StepEntry) =>
      inner.appendStep(runId, entry),
    ),
  };
}

/** The arguments the call with this index was made with. */
export function callArgs(events: readonly Ev[], i: number): readonly unknown[] | undefined {
  return events.find((ev) => ev.i === i && ev.kind === "call")?.args;
}

/** Tokens a `deliverHook` accepted — it answers the run id it woke. */
export function deliveredTokens(events: readonly Ev[]): Set<string> {
  const out = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== "ret" || ev.method !== "deliverHook" || ev.value === undefined) continue;
    const token = callArgs(events, ev.i)?.[0];
    if (typeof token === "string") out.add(token);
  }
  return out;
}

/**
 * Did this `setStatus` call move the run terminal under a compare-and-set?
 *
 * The `expect` argument is what makes it one, and it is what the engine's
 * terminal writes carry: `recordOutcome` passes `["running"]` and `cancel`
 * passes `["pending", "running"]`. `abandon` passes none, deliberately, which is
 * why this reads the argument rather than the status alone.
 */
export function isGuardedTerminalMove(ev: Ev, args: readonly unknown[] | undefined): boolean {
  if (ev.method !== "setStatus" || args === undefined) return false;
  // The SET comes from the SDK rather than a local list, for the reason
  // `isTerminalStatus`'s own doc gives — four independent statements of "which
  // statuses are terminal" existed before that one imported this. The predicate
  // is spelled out here only because the argument is `unknown` off a log where
  // `isTerminalStatus` takes a `RunStatus`.
  const next = args[1];
  return (
    typeof next === "string" &&
    (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(next) &&
    args[3] !== undefined
  );
}
