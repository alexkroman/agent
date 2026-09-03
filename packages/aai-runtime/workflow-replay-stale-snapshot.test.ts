// Copyright 2026 the AAI authors. MIT license.
/**
 * A walk must not execute a step the journal has already SETTLED.
 *
 * `replayRun` reads the journal once per walk, and nothing bounded how long that
 * snapshot was trusted — so an overlapping delivery answered step after step
 * from a picture of the run taken before any of them existed. Measured on a
 * deployed transcription workflow: the platform's 60-second delivery ceiling
 * closed one delivery's response without stopping its walk, a second walk
 * started 61 s in with an empty snapshot, the first walk went on to COMPLETE the
 * run, and the second then re-ran six steps against the real provider. See
 * `workflow-replay-attempt.ts`'s `settledSince`, which is the fix.
 *
 * Its own file rather than a case in `workflow-replay.test.ts`, which is close
 * to the test cap — and the property is a different one from that suite's:
 * those state what ONE walk does, this states what two walks of one run may not
 * do to each other.
 *
 * `workflow-concurrent-delivery.test.ts` is the generated version of the same
 * claim and is what MEASURED the fix (`duplicateSteps` fell from 44-107 to
 * 6-21). These two cases are the pins: a property says no interleaving breaks
 * it, a pin says this exact interleaving still works.
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";

const RUN_ID = "wrun_stale";

/** A journal holding one running run, ready to replay. */
async function seed(): Promise<JournalStore> {
  const journal = createMemoryJournal();
  await journal.createRun({
    runId: RUN_ID,
    workflow: "probe",
    status: "running",
    createdAt: Date.now(),
    input: {},
  });
  return journal;
}

function replay(
  journal: JournalStore,
  run: (input: Record<string, unknown>, ctx: WorkflowCtx) => Promise<unknown>,
): ReturnType<typeof replayRun> {
  return replayRun({ runId: RUN_ID, workflow: "probe", input: {}, journal, run });
}

describe("a walk whose snapshot went stale", () => {
  /**
   * The shipped shape, reduced to two steps and one gate.
   *
   * Walk A parks inside `probe`. Walk B then runs the whole body — `probe`
   * again, which is the engine's stated at-least-once cost, and then `effect`,
   * which it journals. When A is released it reaches `effect` with a snapshot
   * that predates every one of those writes.
   */
  test("does not execute a step a sibling walk already settled", async () => {
    const journal = await seed();
    const gate = Promise.withResolvers<void>();
    let probeRuns = 0;
    let effectRuns = 0;
    const body = async (_input: Record<string, unknown>, ctx: WorkflowCtx) => {
      const probe = await ctx.step("probe", async () => {
        probeRuns += 1;
        // Only the FIRST walk parks — the second has to be able to finish.
        if (probeRuns === 1) await gate.promise;
        return probeRuns;
      });
      const effect = await ctx.step("effect", () => {
        effectRuns += 1;
        return "did the work";
      });
      return { probe, effect };
    };

    const walkA = replay(journal, body);
    await vi.waitFor(() => expect(probeRuns).toBe(1));
    const walkB = await replay(journal, body);
    expect(walkB).toEqual({ kind: "completed", output: { probe: 2, effect: "did the work" } });

    gate.resolve();
    // A reads B's entry back out of the idempotent append, so the ANSWER was
    // never the thing at risk.
    expect(await walkA).toEqual(walkB);
    // The property. Without `settledSince` this is 2: A's snapshot had no
    // `effect#0`, so it ran the body — on a run B had already finished.
    expect(effectRuns).toBe(1);
    // And `probe` really did run twice, so the assertion above is "the stale
    // read was refused" rather than "the walks never overlapped".
    expect(probeRuns).toBe(2);
  });

  /**
   * The ORDER of the two checks in `chargeAttempt`, which is a decision.
   *
   * A settled step is not a step to refuse: the answer exists. Charging past the
   * budget first would answer `StepAbandonedError` — a failed run — over a step
   * that had succeeded, which is the very trap `StepAbandonedError` was
   * introduced to avoid one layer down.
   */
  test("answers a settled step from the journal even with its budget spent", async () => {
    const journal = await seed();
    // Three attempts outstanding on a budget of three: the next reach is over.
    for (const walk of ["w1", "w2", "w3"])
      await journal.claimAttempt(RUN_ID, "s#0", walk, 60 * 60 * 1000);
    await journal.appendStep(RUN_ID, {
      key: "s#0",
      name: "s",
      status: "ok",
      output: 7,
      attempts: 1,
      finishedAt: Date.now(),
    });

    // Hide the entry from the walk's OPENING read alone, which is exactly what
    // an overlapping delivery sees.
    const readSteps = journal.readSteps.bind(journal);
    let reads = 0;
    vi.spyOn(journal, "readSteps").mockImplementation(async (runId) =>
      reads++ === 0 ? [] : readSteps(runId),
    );

    let ran = 0;
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("s", () => {
        ran += 1;
        return 1;
      }),
    );

    expect(outcome).toEqual({ kind: "completed", output: 7 });
    expect(ran).toBe(0);
  });

  /**
   * A NESTED step answered on that path must not leave its children displaced.
   *
   * The divergence check's soundness rests on a `readThrough` cursor: answering
   * a parent from the journal excuses the children, which are journaled and
   * never re-reached (`workflow-replay-divergence.ts`'s `displaced`). That
   * cursor is fed from the SNAPSHOT's answer, so a parent answered by the
   * second read was invisible to it, and the next first-reached key was refused
   * with the renamed-step message on a run nobody had renamed.
   *
   * Found by the concurrent-delivery property, which flaked at ~60% on the
   * first draft of `settledSince`; `DivergenceWatch.answeredLate` is the fix.
   */
  test("answers a nested step late without refusing the next key as divergence", async () => {
    const journal = await seed();
    // One charge already standing, so `onFirstReach` cannot fire for `outer#0`:
    // a walk beside this one reached it, which is the whole premise.
    await journal.claimAttempt(RUN_ID, "outer#0", "earlier-walk", 60 * 60 * 1000);
    const entry = (key: string, name: string, finishedAt: number) => ({
      key,
      name,
      status: "ok" as const,
      output: 1,
      attempts: 1,
      finishedAt,
    });
    // A parent settles at or AFTER its child, always — it is still running while
    // the child finishes.
    await journal.appendStep(RUN_ID, entry("inner#0", "inner", 1000));
    await journal.appendStep(RUN_ID, entry("outer#0", "outer", 1001));

    // The walk's OPENING read sees only the CHILD. That is the shape the
    // property shrank to: the parent landed after the snapshot was taken, so
    // only the second read can answer it.
    const readSteps = journal.readSteps.bind(journal);
    let reads = 0;
    vi.spyOn(journal, "readSteps").mockImplementation(async (runId) =>
      reads++ === 0
        ? (await readSteps(runId)).filter((step) => step.key === "inner#0")
        : readSteps(runId),
    );

    let afterRuns = 0;
    const outcome = await replay(journal, async (_input, ctx) => {
      const outer = await ctx.step("outer", async () => ctx.step("inner", () => 1));
      const after = await ctx.step("after", () => {
        afterRuns += 1;
        return 2;
      });
      return { outer, after };
    });

    // `after#0` is genuinely first-reached and `inner#0` is unread — the exact
    // pair the check refuses on when the cursor has not advanced. Without
    // `answeredLate` this is `{kind: "failed"}` carrying the renamed-step
    // message.
    expect(outcome).toEqual({ kind: "completed", output: { outer: 1, after: 2 } });
    expect(afterRuns).toBe(1);
  });
});
