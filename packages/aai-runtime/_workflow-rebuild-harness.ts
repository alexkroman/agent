// Copyright 2026 the AAI authors. MIT license.
/**
 * The SECOND crash model: the journal survives, the process's timers do not.
 *
 * `_workflow-resume-program.ts` owns the grammar and the body compiler, shared;
 * `_workflow-resume-harness.ts` owns the FIRST model — a killed WORKER,
 * simulated by aborting the caller's signal at a step boundary. This one
 * interrupts the same generated bodies a different way: `stop()` the engine and
 * build a FRESH `createInProcessWorkflowEngine` over the same journal, which is
 * what a process restart and an `aai dev` rebuild both are.
 *
 * ## Why a second model, stated as the defect it would have caught
 *
 * The first model builds the engine with `dispatch: () => undefined` and drives
 * resumption BY HAND (`engine.execute`, `journal.wakeSleeps`). It therefore
 * never constructs the in-process engine at all, and the dispatcher — the thing
 * that decides *when* a suspended run comes back — is not in its path. A run
 * parked on `ctx.sleep` was for a long time never re-delivered after a restart
 * or a rebuild: the deadline was in the journal and the timer was in a process
 * that had gone away, so the run sat `running` forever on every non-platform
 * backend. That property test passed unchanged throughout, before and after the
 * fix, because the only broken component was one it does not build.
 *
 * The two models differ in exactly one thing, and it is the interesting one:
 *
 * | | killed worker | rebuilt engine |
 * | --- | --- | --- |
 * | journal | intact | intact |
 * | in-flight walk | abandoned mid-step | already quiescent |
 * | dispatcher timers | still armed | **discarded** |
 * | what resumes it | the driver, by hand | `createInProcessWorkflowEngine`'s boot sweep |
 *
 * ## No dispatcher may be injected here, and that is the whole point
 *
 * The boot sweep is SKIPPED when `options.dispatch` was supplied — a deployed
 * guest's schedule is a delayed message in the platform's queue, which has its
 * own reconcile. So a harness that injects a dispatcher to "control" delivery
 * silently switches off the mechanism under test and reports green. This driver
 * therefore lets the engine own its schedule entirely, and everything below is
 * arranged around not needing to steer it.
 *
 * ## Time is VIRTUAL, because the sweep's schedule is real
 *
 * A generated wait is {@link WAIT_MS} (60 s) and the sweep spreads overdue
 * deliveries {@link RESUME_STAGGER_MS} apart, neither of which a unit test may
 * wait out — and shortening the wait to a few real milliseconds would race the
 * teardown against the engine's own timer, so whether the boot sweep was
 * exercised at all would be a scheduling coin-flip. `vi.useFakeTimers()` reaches
 * both, and the whole scenario costs microseconds.
 *
 * It is switched on INSIDE this driver rather than at file scope, and the cost
 * of that is worth naming: the ORACLE is the sibling harness's `runScenario`,
 * which awaits a retryable step's `sleep(0)` on the global timer and would hang
 * forever with nothing advancing a fake clock. So the property runs its oracle
 * on the wall clock and only the rebuilt run on virtual time. `finally` restores
 * real timers — fast-check re-runs a property dozens of times while shrinking,
 * and a leaked fake clock converges the shrinker on the wrong counterexample.
 *
 * ## Where the interruption points are
 *
 * Every SUSPENSION, rather than every step boundary. A rebuild is only
 * observable at a point where the run is parked and quiescent — mid-step there
 * is no engine to tear down that has not already lost the walk, which is the
 * other model's case. So the driver settles, rebuilds, settles, advances the
 * clock past the deadline, and repeats until the run is terminal: every wake in
 * a scenario comes from a boot sweep and none from the engine that armed it.
 */

import { workflow } from "@alexkroman1/aai";
import { vi } from "vitest";
import { type Scenario, silent } from "./_workflow-resume-harness.ts";
import { type Program, type Recorder, runProgram, WAIT_MS } from "./_workflow-resume-program.ts";
import { createTally, journalOutcome } from "./_workflow-tally-harness.ts";
import { createInProcessWorkflowEngine } from "./workflow-in-process.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { isTerminalStatus, type JournalStore } from "./workflow-journal-types.ts";

/**
 * Engines one scenario may build before it is declared stuck.
 *
 * A generated body reaches at most one suspension per node plus the one the
 * property splices in, over programs of at most five nodes. Comfortably clear of
 * that, and low enough that a run nothing can move fails the property in
 * milliseconds instead of looping.
 */
const MAX_REBUILDS = 12;

/**
 * How far the sweep's own stagger may push a delivery past its deadline.
 *
 * `RESUME_STAGGER_MS` is 25 and one scenario has one run, so the real figure is
 * zero; this is slack against that constant changing rather than a measurement.
 */
const STAGGER_SLACK_MS = 1000;

/**
 * Turns of the loop one settle spends looking for quiescence, and how far each
 * one moves the fake clock.
 *
 * Everything inside a delivery is microtasks and zero-delay timers (a retryable
 * step's `retryDelay` is 0 for a plain `Error`), so a bounded number of small
 * advances reaches the parked state; only a durable WAIT needs the clock moved
 * properly.
 *
 * **The step is 1 ms and not 0, and that is the one place virtual time fought
 * back.** A fake `setTimeout(fn, 0)` scheduled from INSIDE a tick is filed at
 * `now + 1` rather than `now` — the fake clock's own guard against a zero-delay
 * timer re-arming itself forever within one tick — so
 * `advanceTimersByTimeAsync(0)` fires the delivery `start` schedules (queued
 * outside a tick) and never the retry `sleep(0)` queued during one. The symptom
 * was not a hang, which is why it is worth writing down: `settle` reported the
 * run PARKED while its first attempt was still waiting to be retried, the driver
 * handed a mid-walk run to a fresh engine, and the oracle reported the double
 * execution the engine had not caused. Cost of the fix: {@link SETTLE_TICKS} ms
 * of virtual time per settle, three orders of magnitude short of
 * {@link WAIT_MS}.
 */
const SETTLE_TICKS = 24;
const SETTLE_STEP_MS = 1;

/** One rebuilt-engine scenario, as the oracle compares it. */
export type RebuildScenario = Scenario & {
  /** Engines built over this journal after the first. Each one is a boot sweep. */
  rebuilds: number;
  /** Rebuilds that inherited at least one already-journaled step. */
  resumedOffJournal: number;
  /** Counted step-body invocations that happened AFTER the first rebuild. */
  stepsAfterRebuild: number;
};

/**
 * Nudge virtual time until the run settles, and say whether it is over.
 *
 * `false` means "parked": every immediate continuation has run and what is left
 * is a durable deadline nobody has reached. It deliberately does not ask the
 * journal WHAT the run is parked on — a run parked on something the sweep
 * excludes simply exhausts {@link MAX_REBUILDS} and fails the property's
 * terminal claim, which is the honest report.
 */
async function settle(journal: JournalStore, runId: string): Promise<boolean> {
  for (let i = 0; i < SETTLE_TICKS; i++) {
    await vi.advanceTimersByTimeAsync(SETTLE_STEP_MS);
    const record = await journal.getRun(runId);
    if (record && isTerminalStatus(record.status)) return true;
  }
  return false;
}

/** The mutable half of one scenario, so the loop below is its own function. */
type Rebuilt = {
  rebuilds: number;
  resumedOffJournal: number;
  /** `started` at the moment of the FIRST rebuild, or absent if there was none. */
  startedAtFirstRebuild: number | undefined;
};

/**
 * Run the body to a terminal status, rebuilding the engine at every suspension.
 *
 * The engine variable is reassigned rather than the loop taking one: a torn-down
 * engine must not be reachable afterwards, and `stop()` on the survivor at the
 * end is what keeps a scenario from leaving an armed timer behind for the next
 * one to trip over.
 */
async function driveRebuilds(
  journal: JournalStore,
  make: () => ReturnType<typeof createInProcessWorkflowEngine>,
  started: () => number,
  tally: Rebuilt,
): Promise<string> {
  let engine = make();
  const runId = await engine.start("generated", [{}]);
  let done = await settle(journal, runId);
  while (!done && tally.rebuilds < MAX_REBUILDS) {
    const inherited = (await journal.readSteps(runId)).length;
    // Tear the world down BEFORE the replacement exists, which is the ordering a
    // restart really has: two live engines over one journal would let the old
    // one's timer answer for the new one's sweep and prove nothing.
    engine.stop();
    engine = make();
    tally.rebuilds++;
    if (inherited > 0) tally.resumedOffJournal++;
    tally.startedAtFirstRebuild ??= started();
    // The sweep is fire-and-forget, so its journal read and its `schedule` land
    // on microtasks; this is what lets them.
    done = await settle(journal, runId);
    if (done) break;
    await vi.advanceTimersByTimeAsync(WAIT_MS + STAGGER_SLACK_MS);
    done = await settle(journal, runId);
  }
  engine.stop();
  return runId;
}

/**
 * Run one generated program, handing it to a fresh engine at every suspension.
 *
 * Takes no options: the interruption points are not chosen, they are wherever
 * the body parks — and `createInProcessWorkflowEngine` exposes no
 * `stepConcurrency`, so the gate width is the runtime's own. The killed-worker
 * property next door is what varies both.
 */
export async function runRebuildScenario(program: Program): Promise<RebuildScenario> {
  const journal = createMemoryJournal();
  const steps = createTally();

  const rec: Recorder = {
    ...steps.counted,
    // This model interrupts BETWEEN deliveries, never inside a body — see the
    // module doc's table. Nothing to inject at a step boundary.
    after: async () => undefined,
  };

  const make = () =>
    createInProcessWorkflowEngine({
      workflows: {
        generated: workflow({
          description: "generated",
          run: (_input, ctx) => runProgram(program, ctx, rec),
        }),
      },
      journal,
      logger: silent,
    });

  const tally: Rebuilt = { rebuilds: 0, resumedOffJournal: 0, startedAtFirstRebuild: undefined };
  vi.useFakeTimers();
  let runId: string;
  try {
    runId = await driveRebuilds(journal, make, () => steps.total, tally);
  } finally {
    vi.useRealTimers();
  }

  return {
    ...(await journalOutcome(journal, runId, steps)),
    // One delivery per engine, as this model counts them.
    deliveries: tally.rebuilds + 1,
    suspends: tally.rebuilds,
    signalled: 0,
    crashed: false,
    rebuilds: tally.rebuilds,
    resumedOffJournal: tally.resumedOffJournal,
    stepsAfterRebuild: steps.total - (tally.startedAtFirstRebuild ?? steps.total),
  };
}
