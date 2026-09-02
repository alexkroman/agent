// Copyright 2026 the AAI authors. MIT license.
/**
 * A step body may not wait — the engine's refusal, and the two bugs it replaced.
 *
 * Both bugs are asserted here as the STATE THAT NO LONGER HAPPENS rather than
 * merely "it throws", because "it throws" is satisfied by a refusal that fires on
 * the wrong shape too. The body-level waits at the bottom are the other half of
 * that: the guard must be invisible to every legal program.
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore, RunRecord } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function seed(): Promise<JournalStore> {
  const journal = createMemoryJournal();
  const record: RunRecord = {
    runId: "wrun_1",
    workflow: "digest",
    status: "running",
    createdAt: Date.now(),
    input: {},
  };
  await journal.createRun(record);
  return journal;
}

function replay(
  journal: JournalStore,
  run: (input: Record<string, unknown>, ctx: WorkflowCtx) => Promise<unknown> | unknown,
) {
  return replayRun({ runId: "wrun_1", workflow: "digest", input: {}, run, journal });
}

/** The failure message, or a name for whatever else the outcome was. */
function failureMessage(outcome: Awaited<ReturnType<typeof replayRun>>): string {
  return outcome.kind === "failed" ? outcome.error.message : `not a failure: ${outcome.kind}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a wait reached inside a step", () => {
  test("fails the run naming the step, the reason and the fix", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("napper", async () => {
        await ctx.sleep(2000);
        return "x";
      }),
    );

    const message = failureMessage(outcome);
    expect(message).toContain('ctx.sleep was called inside ctx.step("napper")');
    expect(message).toContain("a step body may not wait");
    expect(message).toContain("Move the wait out of the step");
  });

  test("runs the step body ONCE, where it used to run once per delivery", async () => {
    // The reported finding. Before the refusal this logged `napper` twice across
    // two deliveries and reported `completed` — so a step calling a paid
    // provider was charged once per suspend.
    vi.useFakeTimers();
    const journal = await seed();
    const enters: string[] = [];
    const body = async (_input: Record<string, unknown>, ctx: WorkflowCtx) =>
      ctx.step("napper", async () => {
        enters.push("napper");
        await ctx.sleep(2000);
        return "x";
      });

    const first = await replay(journal, body);
    vi.advanceTimersByTime(3000);
    const second = await replay(journal, body);

    expect(enters).toEqual(["napper"]);
    expect(first.kind).toBe("failed");
    // The second delivery answers the failed step from the journal rather than
    // running the body again, so the verdict is stable and costs nothing.
    expect(second.kind).toBe("failed");
  });

  test("cannot let a LATER wait in the run read the sleeping step's record", async () => {
    // The sharper half, and not a duplicate-work problem at all. Waits are keyed
    // positionally off a counter that advances only when a wait is REACHED, and
    // a settled step's body is not re-executed — so once `napper#0` landed, the
    // body-level wait slid from `sleep!1` to `sleep!0` and read a record that
    // had already elapsed. Measured before the refusal, clock unmoved between
    // walks 2 and 3:
    //
    //   walk 1 -> suspended                      walk 2 -> suspended, +7 days
    //   walk 3 -> completed
    //
    // A week-long durable wait skipped in full, reported `completed`.
    vi.useFakeTimers();
    const journal = await seed();
    const claimSleep = vi.spyOn(journal, "claimSleep");
    const body = async (_input: Record<string, unknown>, ctx: WorkflowCtx) => {
      await ctx.step("napper", async () => {
        await ctx.sleep(2000);
        return "x";
      });
      await ctx.sleep(WEEK_MS);
      return "done";
    };

    const first = await replay(journal, body);
    vi.advanceTimersByTime(3000);
    const second = await replay(journal, body);
    const third = await replay(journal, body);

    // Refused on the first walk, so the week-long wait is never mis-keyed and
    // no walk can reach the `completed` that used to end this run.
    expect([first.kind, second.kind, third.kind]).toEqual(["failed", "failed", "failed"]);
    // And no wait ever entered the key space, so there is nothing for a later
    // one to slide onto — the refusal lands BEFORE the positional counter moves.
    expect(claimSleep).not.toHaveBeenCalled();
  });

  test("refuses ctx.waitFor too, where the shifted key hands over a PAYLOAD", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("approver", () => ctx.waitFor("tok_review")),
    );
    expect(failureMessage(outcome)).toContain('ctx.waitFor was called inside ctx.step("approver")');
  });

  test("sees a wait reached inside a HELPER the step awaited", async () => {
    // The run context is narrowed for the whole of the body's execution, so the
    // check does not depend on the wait being lexically in the callback — which
    // is exactly where an accidental one hides.
    const journal = await seed();
    const poll = async (ctx: WorkflowCtx) => {
      await ctx.sleep(1000);
    };
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("outer", async () => {
        await poll(ctx);
        return "x";
      }),
    );
    expect(failureMessage(outcome)).toContain('inside ctx.step("outer")');
  });

  test("names the INNER step when steps are nested", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("outer", () =>
        ctx.step("inner", async () => {
          await ctx.sleep(1000);
          return "x";
        }),
      ),
    );
    expect(failureMessage(outcome)).toContain('inside ctx.step("inner")');
  });

  test("fails the run even when the body swallows the refusal", async () => {
    // The property `refused` exists for: a body that catches broadly must not be
    // able to turn an engine refusal into `completed`. Unlike a SUSPENSION —
    // which the body can no longer see at all — a refusal still travels as a
    // throw, so this catch really does run and `refused` is what overrules it.
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      try {
        await ctx.step("napper", async () => {
          await ctx.sleep(2000);
          return "x";
        });
      } catch {
        return "swallowed";
      }
      return "reached";
    });
    expect(outcome.kind).toBe("failed");
    expect(failureMessage(outcome)).toContain("a step body may not wait");
  });

  test("does not retry it — a redelivery cannot make a body legal", async () => {
    const journal = await seed();
    const enters: string[] = [];
    await replay(journal, async (_input, ctx) =>
      ctx.step(
        "napper",
        async () => {
          enters.push("napper");
          await ctx.sleep(2000);
          return "x";
        },
        { maxAttempts: 5 },
      ),
    );
    expect(enters).toHaveLength(1);
  });
});

describe("the guard is invisible to a legal body", () => {
  test("a body-level sleep still suspends", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      await ctx.sleep(60_000);
      return "done";
    });
    expect(outcome.kind).toBe("suspended");
  });

  test("a body-level sleep AFTER a step still suspends", async () => {
    // The context is narrowed by entering a fresh one, so a step resolving puts
    // the body back at body level rather than leaving `step` set.
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      await ctx.step("work", () => 1);
      await ctx.sleep(60_000);
      return "done";
    });
    expect(outcome.kind).toBe("suspended");
  });

  test("a body-level waitFor still suspends", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) => ctx.waitFor("tok_gate"));
    expect(outcome.kind).toBe("suspended");
  });

  test("a step that does not wait is journaled and answered as before", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) => ctx.step("work", () => 41 + 1));
    expect(outcome).toEqual({ kind: "completed", output: 42 });
  });
});
