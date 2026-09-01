// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine's own specs, and the reference for what "durable" means here.
 *
 * The replay properties are the ones worth stating out loud, because they are
 * what the Workflow DevKit used to guarantee and what this now has to: a step
 * runs once, a redelivery costs no re-execution, and two walks of the same body
 * see the same values. Each has a test below whose name is the property.
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import { describe, expect, test, vi } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore, RunRecord } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";

/** A run record and the journal holding it, ready to replay. */
async function seed(
  input: Record<string, unknown> = {},
  journal: JournalStore = createMemoryJournal(),
): Promise<{ journal: JournalStore; record: RunRecord }> {
  const record: RunRecord = {
    runId: "wrun_1",
    workflow: "digest",
    status: "running",
    createdAt: Date.now(),
    input,
  };
  await journal.createRun(record);
  return { journal, record };
}

/** Replay `run` against a journal, with the seeded run's identity. */
function replay(
  journal: JournalStore,
  run: (input: Record<string, unknown>, ctx: WorkflowCtx) => Promise<unknown> | unknown,
  input: Record<string, unknown> = {},
) {
  return replayRun({ runId: "wrun_1", workflow: "digest", input, run, journal });
}

describe("a first execution", () => {
  test("runs the body and reports what it returned", async () => {
    const { journal } = await seed({ topic: "otters" });
    // The body is handed `unknown` — the engine does not know a def's schema —
    // so a real body narrows exactly like this one does.
    const outcome = await replay(
      journal,
      async (input, ctx) => {
        const { topic } = input as { topic: string };
        const notes = await ctx.step("research", () => `notes on ${topic}`);
        return { notes };
      },
      { topic: "otters" },
    );
    expect(outcome).toEqual({ kind: "completed", output: { notes: "notes on otters" } });
  });

  test("journals each settled step under `name#occurrence`", async () => {
    const { journal } = await seed();
    await replay(journal, async (_input, ctx) => {
      await ctx.step("a", () => 1);
      await ctx.step("b", () => 2);
    });
    const steps = await journal.readSteps("wrun_1");
    expect(steps.map((s) => s.key)).toEqual(["a#0", "b#0"]);
    expect(steps.map((s) => s.output)).toEqual([1, 2]);
  });

  test("gives one call site in a loop a distinct key per iteration", async () => {
    const { journal } = await seed();
    await replay(journal, async (_input, ctx) => {
      for (let i = 0; i < 3; i++) await ctx.step("tick", () => i);
    });
    const steps = await journal.readSteps("wrun_1");
    expect(steps.map((s) => s.key)).toEqual(["tick#0", "tick#1", "tick#2"]);
  });
});

describe("a replay", () => {
  test("answers a completed step from the journal instead of running it again", async () => {
    const { journal } = await seed();
    const body = vi.fn(async (_input: unknown, ctx: WorkflowCtx) => {
      const first = await ctx.step("once", work);
      const second = await ctx.step("twice", work);
      return [first, second];
    });
    const work = vi.fn(() => "done");

    await replay(journal, body);
    expect(work).toHaveBeenCalledTimes(2);

    // Second delivery of the same run — the body walks again, the steps do not.
    const again = await replay(journal, body);
    expect(work).toHaveBeenCalledTimes(2);
    expect(again).toEqual({ kind: "completed", output: ["done", "done"] });
  });

  test("resumes a run that crashed midway without redoing what landed", async () => {
    const { journal } = await seed();
    const ran: string[] = [];
    const crashing = async (_input: unknown, ctx: WorkflowCtx) => {
      await ctx.step("first", () => {
        ran.push("first");
        return 1;
      });
      await ctx.step("boom", () => {
        ran.push("boom");
        throw new FatalError("the process died here");
      });
    };
    await replay(journal, crashing);
    expect(ran).toEqual(["first", "boom"]);

    // The completed step is journaled; the failed one is too, and stays failed.
    const resumed = await replay(journal, crashing);
    expect(ran).toEqual(["first", "boom"]);
    expect(resumed.kind).toBe("failed");
  });

  test("re-throws a journaled failure, so a body that caught it takes the same branch", async () => {
    const { journal } = await seed();
    const branches: string[] = [];
    const body = async (_input: unknown, ctx: WorkflowCtx) => {
      try {
        await ctx.step("flaky", () => {
          throw new FatalError("nope");
        });
        branches.push("success");
      } catch {
        branches.push("caught");
      }
      return branches.length;
    };
    await replay(journal, body);
    await replay(journal, body);
    // Both walks took the SAME branch — the failure is deterministic on replay.
    expect(branches).toEqual(["caught", "caught"]);
  });
});

describe("attempts", () => {
  test("retries a retryable failure and keeps the successful result", async () => {
    const { journal } = await seed();
    let calls = 0;
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("flaky", () => {
        calls++;
        if (calls < 3) throw new RetryableError("later", { retryAfter: 0 });
        return "eventually";
      }),
    );
    expect(calls).toBe(3);
    expect(outcome).toEqual({ kind: "completed", output: "eventually" });
  });

  test("does not retry a FatalError, however many attempts remain", async () => {
    const { journal } = await seed();
    let calls = 0;
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step(
        "terminal",
        () => {
          calls++;
          throw new FatalError("will never work");
        },
        { maxAttempts: 5 },
      ),
    );
    expect(calls).toBe(1);
    expect(outcome).toEqual({ kind: "failed", error: { message: "will never work" } });
  });

  test("stops at maxAttempts and fails the run", async () => {
    const { journal } = await seed();
    let calls = 0;
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step(
        "doomed",
        () => {
          calls++;
          throw new RetryableError("still no", { retryAfter: 0 });
        },
        { maxAttempts: 2 },
      ),
    );
    expect(calls).toBe(2);
    expect(outcome.kind).toBe("failed");
  });

  test("burns an attempt on a boot that never ran the body", async () => {
    // The claim happens BEFORE the step body, which is what makes a step that
    // wedges the guest reach its ceiling rather than be redelivered forever.
    const { journal } = await seed();
    await journal.claimAttempt("wrun_1", "wedged#0");
    await journal.claimAttempt("wrun_1", "wedged#0");
    let calls = 0;
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step(
        "wedged",
        () => {
          calls++;
          return "ok";
        },
        { maxAttempts: 3 },
      ),
    );
    // The third and last attempt is the one this execution gets.
    expect(calls).toBe(1);
    expect(outcome.kind).toBe("completed");
  });

  test("refuses a step whose attempts were all burned before it ran", async () => {
    const { journal } = await seed();
    for (let i = 0; i < 3; i++) await journal.claimAttempt("wrun_1", "spent#0");
    const work = vi.fn(() => "ok");
    const outcome = await replay(journal, async (_input, ctx) => ctx.step("spent", work));
    expect(work).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("failed");
  });

  test("a body may catch a step that ran out of attempts and carry on", async () => {
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      try {
        await ctx.step(
          "optional",
          () => {
            throw new RetryableError("no", { retryAfter: 0 });
          },
          { maxAttempts: 1 },
        );
      } catch {
        return "fell back";
      }
      return "unreachable";
    });
    expect(outcome).toEqual({ kind: "completed", output: "fell back" });
  });
});

describe("concurrent deliveries", () => {
  test("both executions return the FIRST journaled result for a step", async () => {
    // Two workers racing on one run must not diverge: whichever appends first
    // decides, and the loser adopts that value rather than its own.
    const { journal } = await seed();
    const outputs: unknown[] = [];
    let n = 0;
    const body = async (_input: unknown, ctx: WorkflowCtx) => {
      const value = await ctx.step("racy", () => `attempt-${++n}`);
      outputs.push(value);
      return value;
    };
    const [a, b] = await Promise.all([replay(journal, body), replay(journal, body)]);
    expect(a).toEqual(b);
    expect(new Set(outputs).size).toBe(1);
  });
});

describe("cancellation", () => {
  test("stops before the next step and propagates the abort", async () => {
    const { journal } = await seed();
    const controller = new AbortController();
    const second = vi.fn(() => "should not run");
    await expect(
      replayRun({
        runId: "wrun_1",
        workflow: "digest",
        input: {},
        journal,
        signal: controller.signal,
        run: async (_input, ctx) => {
          await ctx.step("first", () => "ran");
          controller.abort();
          await ctx.step("second", second);
        },
      }),
    ).rejects.toThrow();
    expect(second).not.toHaveBeenCalled();
  });
});

describe("durable sleep", () => {
  test("suspends on a wait that has not elapsed, reporting when to come back", async () => {
    const { journal } = await seed();
    const after = vi.fn(() => "later");
    const outcome = await replay(journal, async (_input, ctx) => {
      await ctx.sleep(60_000);
      return ctx.step("after", after);
    });
    expect(outcome.kind).toBe("suspended");
    expect(after).not.toHaveBeenCalled();
  });

  test("returns immediately for a deadline already in the past", async () => {
    // Not an error: a run resuming after a long outage meets this legitimately.
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      await ctx.sleep(new Date(Date.now() - 1000));
      return "carried on";
    });
    expect(outcome).toEqual({ kind: "completed", output: "carried on" });
  });

  test("decides the wake time ONCE, so a replay cannot push it further out", async () => {
    // The bug this prevents: `ctx.sleep(60_000)` re-evaluated on every delivery
    // stores a deadline 60s later each time, and the run never wakes.
    const { journal } = await seed();
    const body = async (_input: Record<string, unknown>, ctx: WorkflowCtx) => {
      await ctx.sleep(60_000);
      return "done";
    };
    const first = await replay(journal, body);
    const stored = await journal.claimSleep("wrun_1", "sleep!0", Date.now() + 999_999, undefined);
    await replay(journal, body);
    const after = await journal.claimSleep("wrun_1", "sleep!0", Date.now() + 999_999, undefined);
    expect(first.kind).toBe("suspended");
    expect(after.wakeAt).toBe(stored.wakeAt);
  });

  test("continues past a wait the journal says was woken", async () => {
    const { journal } = await seed();
    const body = async (_input: Record<string, unknown>, ctx: WorkflowCtx) => {
      await ctx.sleep(60_000);
      return ctx.step("after", () => "ran");
    };
    expect((await replay(journal, body)).kind).toBe("suspended");

    expect(await journal.wakeSleeps("wrun_1", undefined)).toBe(1);
    expect(await replay(journal, body)).toEqual({ kind: "completed", output: "ran" });
  });

  test("wakes only the wait a correlation id names", async () => {
    const { journal } = await seed();
    await journal.claimSleep("wrun_1", "sleep!0", Date.now() + 60_000, "review");
    await journal.claimSleep("wrun_1", "sleep!1", Date.now() + 60_000, "backoff");
    expect(await journal.wakeSleeps("wrun_1", ["review"])).toBe(1);
    // The second is untouched, so a targeted wake cannot end an unrelated wait.
    const backoff = await journal.claimSleep("wrun_1", "sleep!1", 0, "backoff");
    expect(backoff.woken).toBe(false);
  });

  test("counts only the waits a wake actually stopped", async () => {
    // Not a tie between "nothing was waiting" and "woke something twice".
    const { journal } = await seed();
    await journal.claimSleep("wrun_1", "sleep!0", Date.now() + 60_000, undefined);
    expect(await journal.wakeSleeps("wrun_1", undefined)).toBe(1);
    expect(await journal.wakeSleeps("wrun_1", undefined)).toBe(0);
  });

  test("does not count a wait that had already elapsed", async () => {
    const { journal } = await seed();
    await journal.claimSleep("wrun_1", "sleep!0", Date.now() - 1, undefined);
    expect(await journal.wakeSleeps("wrun_1", undefined)).toBe(0);
  });

  test("keeps a step named `sleep` clear of the wait key space", async () => {
    // A step's key is `sleep#0` and a wait's is `sleep!0`, so the two cannot
    // alias however the author names their steps.
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      const value = await ctx.step("sleep", () => "a step, not a wait");
      await ctx.sleep(60_000);
      return value;
    });
    expect(outcome.kind).toBe("suspended");
    expect((await journal.readSteps("wrun_1")).map((s) => s.key)).toEqual(["sleep#0"]);
  });

  test("journals each wait in a loop separately", async () => {
    const { journal } = await seed();
    // Two waits, the first already elapsed: the body must reach and suspend on
    // the SECOND rather than re-reading the first.
    await journal.claimSleep("wrun_1", "sleep!0", Date.now() - 1, undefined);
    const outcome = await replay(journal, async (_input, ctx) => {
      for (let i = 0; i < 2; i++) await ctx.sleep(60_000);
      return "both";
    });
    expect(outcome.kind).toBe("suspended");
  });
});
