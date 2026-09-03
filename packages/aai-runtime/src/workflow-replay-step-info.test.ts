// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepInfo()` inside a real step body: the attempt number, the ceiling, and the
 * key, as the ENGINE puts them in front of a body.
 *
 * Its own file rather than more of `workflow-replay.test.ts`, which is against
 * the 700-line test cap, and the seam is the one that file's own doc draws: it
 * states the REPLAY properties (a step runs once, a redelivery costs no
 * re-execution, two walks see the same values) where these are about one step's
 * ATTEMPTS — the same line `workflow-replay-step.ts` was split from
 * `workflow-replay.ts` along.
 *
 * `workflow-report.test.ts` covers the reader's own derivation. What is here is
 * the half only the engine can make good on: "attempt 2" meaning the body has
 * really run twice.
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { publishStepInfoReader } from "@alexkroman1/aai/host-internal";
import { type StepInfo, stepInfo } from "@alexkroman1/aai/step";
import { describe, expect, onTestFinished, test } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore, RunRecord } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";
import { createStepInfoReader } from "./workflow-report.ts";

/** A run record and the journal holding it, ready to replay. */
async function seed(): Promise<{ journal: JournalStore }> {
  const journal = createMemoryJournal();
  const record: RunRecord = {
    runId: "wrun_1",
    workflow: "digest",
    status: "running",
    createdAt: Date.now(),
    input: {},
  };
  await journal.createRun(record);
  return { journal };
}

/** Replay `run` against a journal, with the seeded run's identity. */
function replay(
  journal: JournalStore,
  run: (input: Record<string, unknown>, ctx: WorkflowCtx) => Promise<unknown> | unknown,
) {
  return replayRun({ runId: "wrun_1", workflow: "digest", input: {}, run, journal });
}

/** Publish the real reader for this test, and take it back down after. */
function withReader(): void {
  publishStepInfoReader(createStepInfoReader());
  onTestFinished(() => publishStepInfoReader(undefined));
}

describe("a step body reading its own attempt", () => {
  test("sees 1, then 2, across a retry, with the ceiling it was given", async () => {
    const { journal } = await seed();
    withReader();
    const seen: (StepInfo | undefined)[] = [];

    const outcome = await replay(journal, (_input, ctx) =>
      ctx.step(
        "flaky",
        () => {
          const info = stepInfo();
          seen.push(info);
          // A plain Error, so `retryDelay` is 0 and the retry costs no wall clock.
          if (seen.length === 1) throw new Error("first try fails");
          return "settled";
        },
        { maxAttempts: 4 },
      ),
    );

    expect(outcome).toEqual({ kind: "completed", output: "settled" });
    expect(seen.map((info) => info?.attempt)).toEqual([1, 2]);
    // The ceiling is the CALL SITE's, which is the half a body cannot restate
    // without two literals in two files.
    expect(seen.map((info) => info?.maxAttempts)).toEqual([4, 4]);
    expect(seen.map((info) => info?.isLastAttempt)).toEqual([false, false]);
    expect(seen[0]?.key).toBe("flaky#0");
  });

  test("reports isLastAttempt on the try whose throw ends the step", async () => {
    // The branch the whole surface exists for: degrade rather than fail.
    const { journal } = await seed();
    withReader();
    const last: boolean[] = [];

    await replay(journal, (_input, ctx) =>
      ctx.step(
        "flaky",
        () => {
          last.push(stepInfo()?.isLastAttempt === true);
          throw new Error("always");
        },
        { maxAttempts: 2 },
      ),
    );

    expect(last).toEqual([false, true]);
  });

  test("answers undefined in the BODY, which is not a step", async () => {
    const { journal } = await seed();
    withReader();
    let inBody: StepInfo | undefined;

    await replay(journal, async (_input, ctx) => {
      inBody = stepInfo();
      return await ctx.step("work", () => 1);
    });

    expect(inBody).toBeUndefined();
  });

  test("separates a loop's rounds by key while every round is attempt 1", async () => {
    const { journal } = await seed();
    withReader();
    const keys: string[] = [];

    await replay(journal, async (_input, ctx) => {
      for (let round = 0; round < 3; round++) {
        await ctx.step("tick", () => {
          keys.push(`${stepInfo()?.key}@${stepInfo()?.attempt}`);
          return round;
        });
      }
      return "done";
    });

    expect(keys).toEqual(["tick#0@1", "tick#1@1", "tick#2@1"]);
  });
});
