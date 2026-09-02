// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine under test, over a memory journal — shared by the two specs that
 * drive it — and the POST-CONDITION every run they finish has to satisfy.
 *
 * Its own module because `workflow-engine.test.ts` crossed the 700-line test cap
 * and split at the seam the file already had: LIFECYCLE (`workflow-engine.test.ts`)
 * against a run that PARKS (`workflow-engine-waits.test.ts`). Both need this
 * exact engine, and a copy each is how two specs come to disagree about what
 * they are testing.
 *
 * A `_*-harness.ts` name rather than `_*-test-utils.ts` for a mechanical reason
 * as well as a descriptive one: both are excluded from coverage
 * (`sharedCoverageExclude`), and this is a harness rather than a grab bag.
 *
 * ## Every scenario ends by re-deriving itself, and nothing had to be written
 * ## at the call sites for that
 *
 * {@link expectReplayable} is the interesting half. A spec here asserts a
 * MECHANISM — a cancel answers three ways, a redelivery costs no re-execution, a
 * deadline is decided once — and says nothing about whether the journal it
 * produced on the way is enough to reach that outcome again. That is the only
 * property the word "durable" actually names, and it was checked by exactly two
 * things: the two generated crash models (`_workflow-resume-harness.ts`,
 * `_workflow-rebuild-harness.ts`), which drive bodies from a grammar and
 * therefore cover the shapes that grammar generates and no others.
 *
 * So: take the run's finished write log, drop the one write that moved it
 * terminal, load the rest into an empty world, hand it to `execute`, and require
 * the same answer. {@link harness} registers that as an `onTestFinished` for
 * every world it builds, so it is a post-condition rather than a spec — every
 * hand-written lifecycle test becomes a durability test for the shape THAT test
 * is about, which is the set of shapes a grammar does not reach.
 *
 * ## Why the coverage of that is NOT floored
 *
 * Every gate in this repo whose success output is a count carries a floor, for a
 * reason that applies here too: a post-condition that quietly stops firing
 * prints the same green as one that holds. The floor a reader expects — a final
 * test in each spec asserting "the post-condition ran at least N times" — is
 * refused on a specific ground: it counts the runs the WHOLE FILE happened to
 * finish, so `vitest -t` on any single test fails it, and a check that punishes
 * the most ordinary development loop gets deleted rather than fixed.
 *
 * This is also the file that made `_*-harness.ts` a biome override: a harness
 * that asserts trips `noMisplacedAssertion` and `noConditionalExpect`, both of
 * which are about an assertion STRANDED outside a test. Here it is not stranded
 * — it is registered as one test's teardown — and the two rules stay on for
 * every `*.test.ts` in the repo, where they catch the real thing.
 *
 * What is checked instead is the MECHANISM, in `workflow-journal-log.test.ts`:
 * that {@link harness} really registers the hook, that each derived invariant
 * fires on a log that breaks it, and that {@link rebuildJournal} really
 * reconstructs a world. Those are the things that can rot silently; the two
 * suites' run counts cannot drift to zero without their own assertions going
 * with them.
 */

import { type WorkflowCtx, type WorkflowDef, workflow } from "@alexkroman1/aai";
import { expect, type Mock, onTestFinished, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { checkJournalInvariants } from "./_workflow-journal-invariants.ts";
import {
  isTerminalMove,
  type JournalWrite,
  rebuildJournal,
  recordJournal,
} from "./_workflow-journal-log.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { isTerminalStatus, type JournalStore } from "./workflow-journal-types.ts";
import { createMemoryStreams } from "./workflow-streams.ts";

/** The engine's dispatcher, as a spy. May reject: a queue can be unreachable. */
type DispatchSpy = Mock<(runId: string, at?: number) => void | Promise<void>>;

/** A workflow body, as the engine's registry holds one. */
type Body = (input: Record<string, unknown>, ctx: WorkflowCtx) => unknown;

/** An engine, its journal, and everything the post-condition needs. */
export type EngineWorld = {
  engine: WorkflowEngine;
  /**
   * The store the engine writes through — a {@link recordJournal} wrapper.
   *
   * Handed out rather than kept private because several specs drive the journal
   * directly (a cancel written from inside a body, a wake, a `claimSleep` read
   * back twice), and going through the wrapper is what puts those writes in the
   * log too. A spec that reached the inner store instead would produce a log the
   * rebuild cannot replay.
   */
  journal: JournalStore;
  dispatch: DispatchSpy;
  /** The declared defs, so a replica can be handed the same registry. */
  workflows: Record<string, WorkflowDef>;
  /** Every durable write, in the order it landed. */
  writes: JournalWrite[];
  /**
   * Declare that a run reached its terminal status from OUTSIDE the journal, so
   * the post-condition must not try to re-derive it.
   *
   * The escape exists because one legitimate shape is indistinguishable from a
   * defect in the log: a spec that writes `setStatus(runId, "failed", …)` itself
   * — to check that a run's hook token is released on a failure as well as on a
   * completion — produces exactly the bytes the engine writes when a body
   * throws. Replay the journal without that write and the body parks on its hook
   * again, correctly, and the comparison reports `running` against `failed`.
   *
   * A `why` is required and is printed if the marked run turns out not to be
   * terminal at all, because the alternative to an explicit, argued escape is a
   * blanket rule: "skip every `failed` run" would switch the post-condition off
   * for the whole failure half of the engine.
   *
   * A CANCELLED run needs no marker — a cancel is by definition an external
   * command, never a fact a walk could re-derive, so it is skipped by status.
   */
  settledOutOfBand(runId: string, why: string): void;
  /** What {@link EngineWorld.settledOutOfBand} has been told, for the hook to read. */
  outOfBand: ReadonlyMap<string, string>;
};

/**
 * An engine over a memory journal, with dispatch held back.
 *
 * `dispatch` is a spy rather than an executor, because `start` and `execute`
 * being separate is the property most of these tests turn on — an engine that
 * ran the run inline would make every assertion below about a run that had
 * already finished.
 *
 * Registers {@link expectWorldSound} as an `onTestFinished`, which is what makes
 * the replay post-condition free at the call site. It therefore has to be called
 * from inside a test; that is where all of its callers are, and vitest names the
 * problem loudly if a future one is not.
 */
export function harness(
  bodies: Record<string, Body> = {},
  dispatch: DispatchSpy = vi.fn(),
): EngineWorld {
  const world = unwatchedHarness(bodies, dispatch);
  onTestFinished(async () => {
    await expectWorldSound(world, world.outOfBand);
  });
  return world;
}

/**
 * The same world, with NO post-condition registered.
 *
 * It exists for one caller: `workflow-journal-log.test.ts`, which has to make
 * the post-condition FAIL on purpose. A gate that cannot be shown to fail is
 * indistinguishable from one that checks nothing, and it cannot be shown to fail
 * from inside a test whose own teardown would then also fail.
 *
 * Nothing else should reach for it. {@link harness} is the door, and the reason
 * the two are one function apart rather than two copies is the module doc's:
 * two harnesses that drift are how two specs come to disagree about what they
 * are testing.
 */
export function unwatchedHarness(
  bodies: Record<string, Body> = {},
  dispatch: DispatchSpy = vi.fn(),
): EngineWorld {
  const { journal, writes } = recordJournal(createMemoryJournal());
  const workflows = Object.fromEntries(
    Object.entries(bodies).map(([name, run]) => [
      name,
      // The real declaration path, so a def here is the shape `agent({ workflows })`
      // holds rather than an object literal that happens to have a `run`.
      workflow({ description: name, run }),
    ]),
  );
  let n = 0;
  const engine = createWorkflowEngine({
    workflows,
    journal,
    streams: createMemoryStreams(),
    dispatch,
    newRunId: () => `wrun_${++n}`,
    logger: silentLogger,
  });
  const outOfBand = new Map<string, string>();
  return {
    engine,
    journal,
    dispatch,
    workflows,
    writes,
    outOfBand,
    settledOutOfBand: (runId, why) => {
      outOfBand.set(runId, why);
    },
  };
}

/** Every run this log created, in creation order. */
export function createdRuns(writes: readonly JournalWrite[]): string[] {
  const runs: string[] = [];
  // A `for` rather than `filter().map()`: a predicate in `filter` is not a type
  // guard, so the `map` would need a cast to read `runId` off the union.
  for (const write of writes) {
    if (write.m === "createRun" && write.threw === undefined) runs.push(write.runId);
  }
  return runs;
}

/**
 * The whole post-condition: the log is sound, and every run that FINISHED can
 * be re-derived from it.
 *
 * Resolves how many runs were re-derived, which is what
 * `workflow-journal-log.test.ts` reads to prove the hook is wired.
 *
 * A run that is still parked, or one that was cancelled, is skipped and the
 * reason is stated at {@link expectReplayable} — neither has an answer this log
 * could re-derive. A world whose runs are all skipped still has its invariants
 * checked, which is the half that applies to a log whatever the run did.
 */
export async function expectWorldSound(
  world: EngineWorld,
  outOfBand: ReadonlyMap<string, string> = new Map(),
): Promise<number> {
  expect(checkJournalInvariants(world.writes), "journal invariants").toEqual([]);
  let rederived = 0;
  for (const runId of createdRuns(world.writes)) {
    const record = await world.journal.getRun(runId);
    if (!(record && isTerminalStatus(record.status))) continue;
    // A cancel is an external command by definition; anything else claiming to
    // be out of band has to say so, and has to still have finished.
    if (record.status === "cancelled") continue;
    const why = outOfBand.get(runId);
    if (why !== undefined) {
      expect(isTerminalStatus(record.status), `${runId} settledOutOfBand: ${why}`).toBe(true);
      continue;
    }
    await expectReplayable(world, runId);
    rederived++;
  }
  return rederived;
}

/**
 * Require that this run's journal is enough to reach this run's answer again.
 *
 * Rebuild the world from the write log minus its terminal move, deliver once,
 * and compare status, payload and journal keys.
 *
 * ## `execute` is the entrypoint, not the boot sweep
 *
 * A rebuild has two halves: is the journal SUFFICIENT, and does a dispatcher
 * come BACK for the run. This checks the first. The second is
 * `_workflow-rebuild-harness.ts`'s whole subject — it builds a real
 * `createInProcessWorkflowEngine`, lets it own its schedule, and refuses to
 * inject a dispatcher precisely because injecting one switches the boot sweep
 * off. Reaching for that engine here would put an unreffed timer and a
 * fire-and-forget journal read into a post-condition that runs after every test
 * in two files, to assert a mechanism that already has a property behind it.
 * `execute` is the door a delivery really comes through either way.
 *
 * ## Only `completed` and `failed` are re-derivable
 *
 * A `cancelled` run's terminal move was decided from OUTSIDE the journal, so
 * there is nothing in the log for a replay to re-derive it from: drop the move
 * and the replica runs the body to the end instead, which is the engine behaving
 * correctly and would read here as a violation. A run that is not terminal at
 * all is refused for the same reason — there is no answer yet to re-derive.
 * Both say so rather than passing quietly, a post-condition that silently checks
 * nothing being worse than no post-condition.
 *
 * ## Its one blind spot is the AUTHOR's, and that is a feature
 *
 * There is no VM here, so a body that reads `Date.now()` or `Math.random()`
 * outside `ctx.now`/`ctx.random` produces a fresh value on the replay walk. That
 * makes this FLAKY rather than failing — which is `guard-invariants` rule 30
 * ("no non-deterministic read in a shipped `workflows/` body") enforced at
 * runtime instead of lexically, reaching a body the lexical rule cannot see
 * because it is written inside a spec.
 */
export async function expectReplayable(world: EngineWorld, runId: string): Promise<void> {
  const finished = await world.journal.getRun(runId);
  if (!finished) expect.fail(`expectReplayable: no run ${runId}`);
  if (!isTerminalStatus(finished.status)) {
    expect.fail(
      `expectReplayable: run ${runId} is ${finished.status} — call it once the run is terminal`,
    );
  }
  if (finished.status === "cancelled") {
    expect.fail(
      `expectReplayable: run ${runId} was cancelled, and a cancel is not journaled work — ` +
        "there is nothing in the log to re-derive it from",
    );
  }
  const keys = (await world.journal.readSteps(runId)).map((entry) => entry.key);

  const terminal = world.writes.findLastIndex(
    (write) => write.m === "setStatus" && write.runId === runId && isTerminalMove(write),
  );
  if (terminal < 0) expect.fail(`expectReplayable: no terminal move logged for run ${runId}`);
  // The PREFIX, not the log with that write punched out — see `rebuildJournal`
  // for the healthy two-run pair a hole reports as a token conflict.
  const replica = await rebuildJournal(world.writes.slice(0, terminal));

  const engine = createWorkflowEngine({
    workflows: world.workflows,
    journal: replica,
    streams: createMemoryStreams(),
    // Nothing may be scheduled: a replay that suspends is a replay that did not
    // re-derive the answer, and the comparison below is what reports it.
    dispatch: () => undefined,
    newRunId: () => "wrun_replay",
    logger: silentLogger,
  });
  const rederived = await engine.execute(runId);
  const record = await replica.getRun(runId);

  expect(
    {
      status: rederived,
      output: record?.output,
      error: record?.error?.message,
      keys: (await replica.readSteps(runId)).map((entry) => entry.key),
    },
    `run ${runId} re-derived from its own journal`,
  ).toEqual({
    status: finished.status,
    output: finished.output,
    error: finished.error?.message,
    keys,
  });
}
