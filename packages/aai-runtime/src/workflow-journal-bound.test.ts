// Copyright 2026 the AAI authors. MIT license.
/**
 * A run's journal has a CEILING, and a run approaching it says so.
 *
 * Two claims, and the second is the one with teeth: the verdict function's
 * thresholds (`journalBound`), and that `replayRun` acts on a refusal BEFORE it
 * runs any body — a bound that let the body run first would be a bound on
 * nothing, since the whole cost it exists to stop is the walk.
 *
 * Why the ceiling exists at all, and why retention does not cover it, is in
 * `workflow-journal-bound.ts`'s module doc.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import type { Mock } from "vitest";
import { describe, expect, test, vi } from "vitest";
import type { Logger } from "./runtime-config.ts";
import {
  journalBound,
  WORKFLOW_JOURNAL_MAX_STEPS,
  WORKFLOW_JOURNAL_WARN_STEPS,
} from "./workflow-journal-bound.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore, StepEntry } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";

const RUN_ID = "wrun_bound";

/**
 * A logger whose `warn` is a spy and whose other levels are inert.
 *
 * `Logger` is a `Record` over every level, so a `{ warn }` literal does not
 * satisfy it — and spelling the other three out per case is the noise this
 * removes.
 */
function warnSpy(): { logger: Logger; warn: Mock } {
  const warn = vi.fn();
  return { logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }, warn };
}

/** A journal holding one running run, plus `steps` settled entries. */
async function seed(steps: number): Promise<JournalStore> {
  const journal = createMemoryJournal();
  await journal.createRun({
    runId: RUN_ID,
    workflow: "grower",
    status: "running",
    createdAt: Date.now(),
    input: {},
  });
  for (let n = 0; n < steps; n++) {
    await journal.appendStep(RUN_ID, entry(n));
  }
  return journal;
}

function entry(n: number): StepEntry {
  return {
    key: `tick#${n}`,
    name: "tick",
    status: "ok",
    output: n,
    error: undefined,
    attempts: 1,
    startedAt: undefined,
    finishedAt: 1000 + n,
  };
}

describe("journalBound classifies a run by how much journal it has", () => {
  test("an ordinary run is ok, and says nothing", () => {
    expect(journalBound(0)).toEqual({ kind: "ok" });
    expect(journalBound(1)).toEqual({ kind: "ok" });
    expect(journalBound(WORKFLOW_JOURNAL_WARN_STEPS - 1)).toEqual({ kind: "ok" });
  });

  test("the warning opens AT the threshold and stays open up to the ceiling", () => {
    // Inclusive at the bottom and exclusive at the top, so no count falls
    // between the two verdicts — the gap is the bug an `>` would introduce.
    expect(journalBound(WORKFLOW_JOURNAL_WARN_STEPS).kind).toBe("warn");
    expect(journalBound(WORKFLOW_JOURNAL_MAX_STEPS - 1).kind).toBe("warn");
  });

  test("the ceiling refuses, and the message names the count, the limit and the remedy", () => {
    const verdict = journalBound(WORKFLOW_JOURNAL_MAX_STEPS);
    expect(verdict.kind).toBe("refuse");
    // A refusal an author cannot act on is the failure this replaces, so the
    // three things they need are asserted rather than assumed.
    if (verdict.kind !== "refuse") return expect.fail("expected a refusal");
    expect(verdict.message).toContain(String(WORKFLOW_JOURNAL_MAX_STEPS));
    expect(verdict.message).toContain("Split the body");
    expect(verdict.steps).toBe(WORKFLOW_JOURNAL_MAX_STEPS);
  });

  test("the warning sits BELOW the ceiling, so there is room to act on it", () => {
    // The whole point of two thresholds. A warning at the ceiling would arrive
    // with nothing left to do but fail.
    expect(WORKFLOW_JOURNAL_WARN_STEPS).toBeLessThan(WORKFLOW_JOURNAL_MAX_STEPS);
    expect(WORKFLOW_JOURNAL_WARN_STEPS).toBeGreaterThan(0);
  });
});

describe("replayRun acts on the bound before it runs a body", () => {
  /**
   * A body that REPLAYS the seeded journal and then does one new step.
   *
   * It has to reach the same `tick#N` keys the fixture settled, or the walk
   * reaches a fresh key with the journal's work still unread — which is exactly
   * what `workflow-replay-divergence.ts` refuses, and the first draft of this
   * file was refused by it. That refusal is the divergence check working; what it
   * meant here was that the fixture described a body that had lost its place
   * rather than one with a long history.
   */
  const grower =
    (steps: number) =>
    async (_input: Record<string, unknown>, ctx: WorkflowContext): Promise<unknown> => {
      for (let n = 0; n < steps; n++) await ctx.step("tick", async () => n);
      return await ctx.step("done", async () => "ok");
    };

  test("a run at the ceiling FAILS, and the body never runs", async () => {
    const journal = await seed(WORKFLOW_JOURNAL_MAX_STEPS);
    const run = vi.fn(grower(WORKFLOW_JOURNAL_MAX_STEPS));
    const outcome = await replayRun({
      runId: RUN_ID,
      workflow: "grower",
      input: {},
      journal,
      run,
    });
    expect(outcome.kind).toBe("failed");
    // The refusal is the point; the body not being ENTERED is what makes it a
    // bound rather than a report — the cost this exists to stop is the walk.
    expect(run).not.toHaveBeenCalled();
    if (outcome.kind !== "failed") return expect.fail("expected a failure");
    expect(outcome.error.message).toContain("ceiling");
  });

  test("a run under the ceiling replays normally, and logs nothing", async () => {
    const journal = await seed(2);
    const { logger, warn } = warnSpy();
    const outcome = await replayRun({
      runId: RUN_ID,
      workflow: "grower",
      input: {},
      journal,
      logger,
      run: grower(2),
    });
    expect(outcome).toEqual({ kind: "completed", output: "ok" });
    expect(warn).not.toHaveBeenCalled();
  });

  test("a run in the warning band replays AND warns, naming the count", async () => {
    // The band is the whole affordance: the run still works, and an operator is
    // told while a body can still be split.
    const journal = await seed(WORKFLOW_JOURNAL_WARN_STEPS);
    const { logger, warn } = warnSpy();
    const outcome = await replayRun({
      runId: RUN_ID,
      workflow: "grower",
      input: {},
      journal,
      logger,
      run: grower(WORKFLOW_JOURNAL_WARN_STEPS),
    });
    expect(outcome.kind).toBe("completed");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      runId: RUN_ID,
      workflow: "grower",
      steps: WORKFLOW_JOURNAL_WARN_STEPS,
      ceiling: WORKFLOW_JOURNAL_MAX_STEPS,
    });
  });

  test("a walk with no logger at all is not an error", async () => {
    // `logger` is optional for the reason `streams` is, and the warning path is
    // the one that would throw on an absent one.
    const journal = await seed(WORKFLOW_JOURNAL_WARN_STEPS);
    const outcome = await replayRun({
      runId: RUN_ID,
      workflow: "grower",
      input: {},
      journal,
      run: grower(WORKFLOW_JOURNAL_WARN_STEPS),
    });
    expect(outcome.kind).toBe("completed");
  });
});
