// Copyright 2026 the AAI authors. MIT license.
/**
 * The divergence check, stated as the bug it exists for and the four legitimate
 * shapes it must not accuse.
 *
 * Its own file rather than more of `workflow-replay.test.ts`, which sits 26
 * lines under the 700-line test cap. Every case drives the real `replayRun`
 * against the real memory journal: the interesting claims are about what the
 * ENGINE does with a journal, and a unit test of the watch alone would pass
 * while the wiring answered `completed`.
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";

const RUN = "wrun_d";

type Body = (input: Record<string, unknown>, ctx: WorkflowCtx) => Promise<unknown> | unknown;

async function seed(): Promise<JournalStore> {
  const journal = createMemoryJournal();
  await journal.createRun({
    runId: RUN,
    workflow: "billing",
    status: "running",
    createdAt: Date.now(),
    input: {},
  });
  return journal;
}

function replay(journal: JournalStore, run: Body) {
  return replayRun({ runId: RUN, workflow: "billing", input: {}, run, journal });
}

/** The message, whichever arm produced it. */
function failure(outcome: Awaited<ReturnType<typeof replayRun>>): string {
  return outcome.kind === "failed" ? outcome.error.message : `not a failure: ${outcome.kind}`;
}

describe("a body whose non-determinism reaches a step NAME", () => {
  /**
   * The measured defect, made deterministic.
   *
   * Live, the name came from `Math.random() < 0.5 ? "h" : "t"` and **7 of 10
   * runs charged twice while all 10 reported `completed`**. A coin is not a
   * regression test, so the same non-determinism is spelled as a variable the
   * spec moves between the two deliveries — the engine cannot tell the
   * difference, which is the whole point of the bug.
   */
  test("is REFUSED on the second walk instead of executing a second time", async () => {
    const journal = await seed();
    const charge = vi.fn(() => "receipt");
    let coin = "h";
    const body: Body = async (_input, ctx) => {
      await ctx.step(`charge-${coin}`, charge);
      await ctx.sleep(1000);
      return "done";
    };

    const first = await replay(journal, body);
    expect(first.kind).toBe("suspended");
    expect(charge).toHaveBeenCalledTimes(1);

    coin = "t";
    await journal.wakeSleeps(RUN, undefined);
    const second = await replay(journal, body);

    expect(second.kind).toBe("failed");
    // The side effect is the assertion. Before the check, this was 2.
    expect(charge).toHaveBeenCalledTimes(1);
  });

  test("names BOTH keys, so the reader can tell a rename from a computed name", async () => {
    const journal = await seed();
    let coin = "h";
    const body: Body = async (_input, ctx) => {
      await ctx.step(`charge-${coin}`, () => "receipt");
      await ctx.sleep(1000);
    };
    await replay(journal, body);
    coin = "t";
    await journal.wakeSleeps(RUN, undefined);
    const message = failure(await replay(journal, body));

    expect(message).toContain("charge-t#0");
    expect(message).toContain("charge-h#0");
    // The two causes, each with its own remedy — see `divergedMessage`.
    expect(message).toContain("CODE changed");
    expect(message).toContain("BODY is non-deterministic");
  });

  /**
   * The quieter half, and the one the live reproduction actually took: a body
   * that catches broadly swallows the refusal and carries on to an answer.
   * `recap-workflow`'s saga is the shipped shape.
   */
  test("still fails the run when the body SWALLOWS the refusal", async () => {
    const journal = await seed();
    let coin = "h";
    const body: Body = async (_input, ctx) => {
      try {
        await ctx.step(`charge-${coin}`, () => "receipt");
      } catch {
        return "recovered";
      }
      await ctx.sleep(1000);
      return "done";
    };
    await replay(journal, body);
    coin = "t";
    await journal.wakeSleeps(RUN, undefined);

    const outcome = await replay(journal, body);
    expect(outcome.kind).toBe("failed");
    expect(failure(outcome)).toContain("Workflow replay diverged");
  });
});

describe("what the check must NOT accuse", () => {
  test("a FIRST walk, whose journal is empty, however many steps it mints", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      for (const name of ["a", "b", "c"]) await ctx.step(name, () => name);
      return "ok";
    });
    expect(outcome).toEqual({ kind: "completed", output: "ok" });
  });

  test("new work appended past the end of a fully-read journal", async () => {
    const journal = await seed();
    let tail = false;
    const body: Body = async (_input, ctx) => {
      await ctx.step("head", () => 1);
      if (!tail) {
        await ctx.sleep(1000);
        return "waited";
      }
      return await ctx.step("tail", () => 2);
    };
    expect((await replay(journal, body)).kind).toBe("suspended");
    tail = true;
    await journal.wakeSleeps(RUN, undefined);
    expect(await replay(journal, body)).toEqual({ kind: "completed", output: 2 });
  });

  /**
   * A crash mid-fan-out leaves GAPS: `segment#1` settled while `segment#0` was
   * still in flight. Unseen on its own would accuse the resume — the attempt
   * claim is what exonerates it, and this is the case that pays for reading it.
   */
  test("a fan-out gap, where the missing key was REACHED and lost", async () => {
    const journal = await seed();
    // `segment#0` was reached and never settled; `segment#1` landed.
    await journal.claimAttempt(RUN, "segment#0");
    await journal.appendStep(RUN, {
      key: "segment#1",
      name: "segment",
      status: "ok",
      output: "one",
      attempts: 1,
      finishedAt: Date.now(),
    });

    const ran = vi.fn((n: number) => `re-${n}`);
    const outcome = await replay(journal, async (_input, ctx) =>
      Promise.all([0, 1].map((n) => ctx.step("segment", () => ran(n)))),
    );

    expect(outcome).toEqual({ kind: "completed", output: ["re-0", "one"] });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  /**
   * The shape that broke the naive check, found by
   * `workflow-resume-equivalence.test.ts` rather than by anyone's imagination.
   *
   * A replay answers the OUTER step from the journal and never runs its
   * callback, so the INNER key is journaled, never re-read, and stays unread for
   * the life of the walk. Treated as evidence, it accuses every later
   * first-reached step — a resumable run turned into a failed one, with no
   * author mistake anywhere in it. `displaced()`'s `finishedAt` test is what
   * excuses it: a child settles at or before its parent.
   */
  test("an orphaned INNER key, which a replay legitimately never re-reads", async () => {
    const journal = await seed();
    const inner = vi.fn(() => "in");
    const tail = vi.fn(() => "tail");
    let reachedTail = false;
    const body: Body = async (_input, ctx) => {
      await ctx.step("outer", () => ctx.step("inner", inner));
      await ctx.sleep(1000);
      reachedTail = true;
      return await ctx.step("tail", tail);
    };

    expect((await replay(journal, body)).kind).toBe("suspended");
    expect(inner).toHaveBeenCalledTimes(1);

    await journal.wakeSleeps(RUN, undefined);
    const outcome = await replay(journal, body);

    expect(reachedTail).toBe(true);
    expect(outcome).toEqual({ kind: "completed", output: "tail" });
    // The inner step is answered by its parent's entry, so it never re-runs.
    expect(inner).toHaveBeenCalledTimes(1);
    expect(tail).toHaveBeenCalledTimes(1);
  });
});
