// Copyright 2026 the AAI authors. MIT license.
/**
 * A killed WORKER, and the run handed to a fresh delivery afterwards.
 *
 * This exists so `workflow-resume-equivalence.test.ts` can state the engine's
 * defining property — "resuming at any interruption point yields the same answer
 * as never being interrupted, and every step body runs exactly as often" — over
 * bodies nobody wrote by hand. The engine's other suites cover MECHANISMS (does
 * `appendStep` write a row?); this covers the thing those mechanisms exist for.
 *
 * The bodies themselves are `_workflow-resume-program.ts`, shared with the other
 * crash model and re-exported at the bottom of this file so a reader has one
 * import to make.
 *
 * ## Two crash models, and this file owns the FIRST
 *
 * A killed WORKER lives here; a rebuilt ENGINE lives in
 * `_workflow-rebuild-harness.ts`. The model below keeps the process (and its
 * timers) and takes the delivery away; the one next door keeps the journal and
 * takes the TIMERS away. Nothing here can reach that second case — this driver
 * builds the engine with `dispatch: () => undefined` and hand-drives
 * resumption, so the dispatcher is not in its path at all, and that blind spot
 * cost a real defect.
 *
 * ## A crash is the CALLER's abort signal, and that is the faithful model
 *
 * `attemptLoop` calls `signal?.throwIfAborted()` at the top of every attempt —
 * before `claimAttempt`, so before an attempt is burned and before any body runs
 * — and `replayRun` re-throws an abort whose reason is the caller's rather than
 * recording it as a run failure. So aborting a caller-supplied signal at a step
 * boundary reproduces exactly what a killed worker leaves behind: the run still
 * `running`, the journal holding every step that settled, and `execute`
 * rejecting rather than writing a verdict. A redelivery is then just calling
 * `execute` again, which is what the platform's queue does.
 *
 * The one thing the simulation cannot do is stop work already in flight — a real
 * process death does. So a crash is followed by a macrotask DRAIN, which lets a
 * fan-out sibling that was already past the abort check finish and journal.
 * Without it, whether that sibling's row lands before or after the resuming
 * walk's `readSteps` is a scheduling coin-flip, and the oracle would report a
 * double execution that the engine did not cause.
 */

import { workflow } from "@alexkroman1/aai";
import { tick } from "./_test-utils.ts";
import {
  type HookMode,
  type Program,
  type Recorder,
  runProgram,
  tokensOf,
} from "./_workflow-resume-program.ts";
import { createTally, type JournalOutcome, journalOutcome } from "./_workflow-tally-harness.ts";
import { silentLogger } from "./runtime-config.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { isTerminalStatus, type JournalStore, type RunStatus } from "./workflow-journal-types.ts";
import { createMemoryStreams } from "./workflow-streams.ts";

/**
 * The grammar the SUITE names, re-exported so one import serves it.
 *
 * Listed rather than `export *`: a wildcard needs Biome's `noReExportAll`
 * suppressed, `check:hatches` counts every such suppression, and the sanctioned
 * place for that one is a real `*-barrel.ts` — a pure re-export surface — which
 * this is not. (Spelling the suppression's NAME in this paragraph is enough to
 * fail that gate, the five suppression patterns deliberately not skipping
 * comment-only lines.) Anything not named here is imported from
 * `_workflow-resume-program.ts` directly, as `_workflow-rebuild-harness.ts`
 * does.
 */
export {
  expectedOutput,
  fails,
  type HookMode,
  type Leaf,
  label,
  type Node,
  type Program,
} from "./_workflow-resume-program.ts";

/** Deliveries one scenario may take before it is declared stuck. */
const MAX_DELIVERIES = 40;

/** What one execution of a program did, as the oracle compares it. */
export type Scenario = JournalOutcome & {
  /** Deliveries of the run message this scenario took. */
  deliveries: number;
  /** Suspends the driver had to advance past. */
  suspends: number;
  /** Hook waits this scenario answered with a signal. */
  signalled: number;
  /** True when the simulated crash really made a delivery fail. */
  crashed: boolean;
};

/** Knobs one scenario takes. */
export type ScenarioOptions = {
  /** Kill the worker at the end of this counted invocation (1-based). */
  crashAt?: number | undefined;
  /** Call `engine.cancel` at the end of this counted invocation (1-based). */
  cancelAt?: number | undefined;
  /** The engine's step gate width. 1 is what deadlocked on a nested step. */
  stepConcurrency?: number | undefined;
};

/**
 * The world one run is driven through, mutated in place by {@link deliverOnce}.
 *
 * A bag rather than closure state, so the delivery loop is its own function —
 * `runScenario` was one body deciding four things at once and Biome measured it
 * over the complexity cap.
 */
type Drive = {
  engine: WorkflowEngine;
  journal: JournalStore;
  runId: string;
  /** Every hook the program declares, in reach order. */
  tokens: { token: string; mode: HookMode }[];
  /** Tokens a signal has already been delivered for. */
  answered: Set<string>;
  suspends: number;
  crashed: boolean;
};

/** What one delivery decided: the run is over, deliver again, or nothing can move it. */
type Advance = "done" | "again" | "stuck";

/**
 * Deliver the run once, then advance whatever it is waiting on.
 *
 * `live` is this delivery's own controller, which the recorder aborts to
 * simulate the worker dying — one per delivery, so a program that suspends ten
 * times before its crash point does not stack ten `AbortSignal.any` listeners on
 * one signal and trip the leak detector.
 */
async function deliverOnce(drive: Drive, live: AbortController): Promise<Advance> {
  let status: RunStatus | undefined;
  try {
    status = await drive.engine.execute(drive.runId, live.signal);
  } catch (err: unknown) {
    if (!live.signal.aborted) throw err;
    drive.crashed = true;
    // Let whatever was already past the abort check settle and journal, which a
    // real process death would have done by dying. See this module's doc.
    await tick();
    await tick();
    return "again";
  }
  if (status && isTerminalStatus(status)) return "done";
  drive.suspends++;
  if ((await drive.journal.wakeSleeps(drive.runId, undefined)) > 0) return "again";
  return answerHook(drive);
}

/** Signal the hook the body is parked on, if there is one left to answer. */
async function answerHook(drive: Drive): Promise<Advance> {
  const parked = drive.tokens.find(
    (hook) => hook.mode !== "timeout" && !drive.answered.has(hook.token),
  );
  if (!parked) return "stuck";
  drive.answered.add(parked.token);
  // A token the body has not registered yet answers `false` and costs nothing;
  // the next delivery finds it.
  if (!(await drive.engine.signal(parked.token, { ok: parked.token }))) {
    drive.answered.delete(parked.token);
  }
  return "again";
}

/**
 * Run one generated program to a terminal status, optionally killing the worker
 * or cancelling the run at a chosen step boundary.
 */
export async function runScenario(
  program: Program,
  options: ScenarioOptions = {},
): Promise<Scenario> {
  const journal = createMemoryJournal();
  const tally = createTally();
  let crashArmed = options.crashAt !== undefined;
  let cancelArmed = options.cancelAt !== undefined;
  let deliveries = 0;
  /** The controller of the delivery in flight — see {@link deliverOnce}. */
  let live: AbortController | undefined;

  const rec: Recorder = {
    ...tally.counted,
    async after(seq) {
      if (crashArmed && options.crashAt === seq) {
        crashArmed = false;
        live?.abort(new Error("the worker died here"));
      }
      if (cancelArmed && options.cancelAt === seq) {
        cancelArmed = false;
        await engine.cancel(runId);
      }
    },
  };

  const engine: WorkflowEngine = createWorkflowEngine({
    workflows: {
      generated: workflow({
        description: "generated",
        run: (_input, ctx) => runProgram(program, ctx, rec),
      }),
    },
    journal,
    streams: createMemoryStreams(),
    // Held back: `start` and `execute` are separate, and this driver is what
    // decides when a delivery happens.
    dispatch: () => undefined,
    newRunId: () => "wrun_generated",
    stepConcurrency: options.stepConcurrency ?? 4,
    logger: silentLogger,
  });

  const runId = await engine.start("generated", [{}]);
  const drive: Drive = {
    engine,
    journal,
    runId,
    tokens: tokensOf(program),
    answered: new Set<string>(),
    suspends: 0,
    crashed: false,
  };

  for (deliveries = 1; deliveries <= MAX_DELIVERIES; deliveries++) {
    live = new AbortController();
    if ((await deliverOnce(drive, live)) !== "again") break;
  }

  return {
    ...(await journalOutcome(journal, runId, tally)),
    deliveries,
    suspends: drive.suspends,
    signalled: drive.answered.size,
    crashed: drive.crashed,
  };
}
