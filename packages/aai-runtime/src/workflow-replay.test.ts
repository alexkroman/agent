// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine's own specs, and the reference for what "durable" means here.
 *
 * The replay properties are the ones worth stating out loud, because they are
 * what the Workflow DevKit used to guarantee and what this now has to: a step
 * runs once, a redelivery costs no re-execution, and two walks of the same body
 * see the same values. Each has a test below whose name is the property.
 *
 * The SUSPENSION properties are next door, in `workflow-replay-suspend.test.ts`:
 * what a body can observe of its own wait, and how concurrent waits aggregate.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import { publishStepReporter } from "@alexkroman1/aai/host-internal";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import { describe, expect, onTestFinished, test, vi } from "vitest";
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
  run: (input: Record<string, unknown>, ctx: WorkflowContext) => Promise<unknown> | unknown,
  input: Record<string, unknown> = {},
) {
  return replayRun({ runId: "wrun_1", workflow: "digest", input, run, journal });
}

/**
 * Capture what the engine NARRATES for the duration of one test.
 *
 * The reporter slot is process-global (`sdk/step-report.ts`), so it is installed
 * and taken back down per test — and taking it down matters twice over: an
 * unpublished slot makes `stepReport()` fall back to the console, which would put
 * the engine's retry lines in every other suite's output.
 */
function reportedLines(): () => string[] {
  const lines: string[] = [];
  publishStepReporter(async (chunk) => {
    lines.push(String(chunk));
  });
  onTestFinished(() => publishStepReporter(undefined));
  return () => lines;
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
    const body = vi.fn(async (_input: unknown, ctx: WorkflowContext) => {
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
    const crashing = async (_input: unknown, ctx: WorkflowContext) => {
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
    const body = async (_input: unknown, ctx: WorkflowContext) => {
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
    // Captured and discarded: this test is about the RESULT, and an
    // unpublished reporter slot sends the engine's retry lines to the console.
    reportedLines();
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

  // The gap that cost hours: only the LAST attempt was recorded, and only as
  // `error.message` on the journal entry — so a step that failed three times
  // and then succeeded left NOTHING anywhere saying why. The whole visible
  // output was the body's own progress line with `(attempt N)` after it, which
  // reads as a slow step rather than as a step hitting a wall in 5 seconds and
  // walking into it again. Two failures, two records.
  test("a non-final failure is recorded, not discarded", async () => {
    const lines = reportedLines();
    const { journal } = await seed();
    let calls = 0;
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("convert", () => {
        calls++;
        if (calls < 3) throw new RetryableError("no space left on device", { retryAfter: 0 });
        return "converted";
      }),
    );
    expect(outcome).toEqual({ kind: "completed", output: "converted" });
    // The successful attempt is NOT one of these: a step that worked has
    // nothing to explain, and the journal entry records it.
    expect(lines()).toEqual([
      "Step convert failed on attempt 1 of 3, retrying in 0ms: no space left on device",
      "Step convert failed on attempt 2 of 3, retrying in 0ms: no space left on device",
    ]);
  });

  // The `cause` exists in exactly one place — the live value in the attempt
  // loop's `catch`. `stepFailure` rebuilds a failed step from the message
  // alone, by design, so a line that dropped the chain would drop the only
  // sentence that says which filesystem filled and how big it was.
  test("a reported failure carries what caused it", async () => {
    const lines = reportedLines();
    const { journal } = await seed();
    await replay(journal, async (_input, ctx) =>
      ctx.step(
        "convert",
        () => {
          throw new RetryableError("Ran out of space writing 660.8 MB to /var/tmp/aai-step-x/out", {
            retryAfter: 0,
            cause: new Error("ENOSPC: no space left on device, write"),
          });
        },
        { maxAttempts: 2 },
      ),
    );
    expect(lines()).toEqual([
      "Step convert failed on attempt 1 of 2, retrying in 0ms: " +
        "Ran out of space writing 660.8 MB to /var/tmp/aai-step-x/out — " +
        "caused by ENOSPC: no space left on device, write",
    ]);
  });

  // A cause whose message the wrapper already quotes adds nothing, and a line
  // that says it twice is what makes an operator stop reading these.
  test("does not repeat a cause the failure already names", async () => {
    const lines = reportedLines();
    const { journal } = await seed();
    await replay(journal, async (_input, ctx) =>
      ctx.step(
        "convert",
        () => {
          throw new RetryableError("convert failed: ffmpeg exited 1", {
            retryAfter: 0,
            cause: new Error("ffmpeg exited 1"),
          });
        },
        { maxAttempts: 2 },
      ),
    );
    expect(lines()).toEqual([
      "Step convert failed on attempt 1 of 2, retrying in 0ms: convert failed: ffmpeg exited 1",
    ]);
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
    reportedLines();
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
    await journal.claimAttempt("wrun_1", "wedged#0", "dead-1", 60 * 60 * 1000);
    await journal.claimAttempt("wrun_1", "wedged#0", "dead-2", 60 * 60 * 1000);
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
    for (const walk of ["dead-1", "dead-2", "dead-3"])
      await journal.claimAttempt("wrun_1", "spent#0", walk, 60 * 60 * 1000);
    const work = vi.fn(() => "ok");
    const outcome = await replay(journal, async (_input, ctx) => ctx.step("spent", work));
    expect(work).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("failed");
    // And JOURNALS NOTHING, which is the half that used to be a defect. The
    // refusal is a verdict about the WALK — nothing failed, the body never ran —
    // so a `failed` entry here is authoritative forever over a step that the
    // walk beside this one may be in the middle of succeeding at. See
    // `StepAbandonedError`, and the attempt-budget finding in
    // `workflow-concurrent-delivery.test.ts`.
    expect(await journal.readSteps("wrun_1")).toEqual([]);
  });

  test("but NOT one whose burned attempts have expired — a death is no longer forever", async () => {
    // The headline of the lease. A charge is a row with a timestamp, so a walk
    // that DIED holding one stops counting once `ATTEMPT_LEASE_MS` has passed.
    // Before that a charge was a scalar counter and could not expire: three
    // deaths on one step key refused it PERMANENTLY, `StepAbandonedError`
    // reported a run nobody could revive, and the module's own doc named the
    // missing mechanism.
    //
    // Aged by moving the CLOCK the store stamps with, not by waiting an hour and
    // not by making the window an option: `claimed_at` is `Date.now()` inside
    // the backend, so three charges taken two hours ago are three charges the
    // engine's own window excludes. `restoreMocks` puts the clock back, and the
    // replay below runs on the real one.
    const { journal } = await seed();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 2 * 60 * 60 * 1000);
    for (const walk of ["dead-1", "dead-2", "dead-3"])
      await journal.claimAttempt("wrun_1", "spent#0", walk, 60_000);
    clock.mockRestore();
    // This walk is the only live one, so the budget is untouched.
    const work = vi.fn(() => "ok");
    const outcome = await replay(journal, async (_input, ctx) => ctx.step("spent", work));
    expect(work).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe("completed");
  });

  test("a refusal beats a suspension, so a broken walk cannot park", async () => {
    // The one ORDERING that changed when suspension stopped being a throw, and
    // it changed towards the truth. A body that catches the engine's refusal and
    // then WAITS used to be recorded `suspended`: the refusal is stable, so
    // every later delivery raised it again and the run read as healthily waiting
    // forever. `classifyThrow` consults `refused` first.
    const { journal } = await seed();
    for (const walk of ["dead-1", "dead-2", "dead-3"])
      await journal.claimAttempt("wrun_1", "spent#0", walk, 60 * 60 * 1000);
    const outcome = await replay(journal, async (_input, ctx) => {
      try {
        await ctx.step("spent", () => "ok");
      } catch {
        // Swallowed — the shape one shipped template really has.
      }
      await ctx.sleep("nap", 60_000);
      return "parked instead";
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome).toMatchObject({
      error: { message: expect.stringContaining("unfinished attempt(s)") },
    });
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
    const body = async (_input: unknown, ctx: WorkflowContext) => {
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
      await ctx.sleep("nap", 60_000);
      return ctx.step("after", after);
    });
    expect(outcome.kind).toBe("suspended");
    expect(after).not.toHaveBeenCalled();
  });

  test("returns immediately for a deadline already in the past", async () => {
    // Not an error: a run resuming after a long outage meets this legitimately.
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      await ctx.sleep("past", new Date(Date.now() - 1000));
      return "carried on";
    });
    expect(outcome).toEqual({ kind: "completed", output: "carried on" });
  });

  test("decides the wake time ONCE, so a replay cannot push it further out", async () => {
    // The bug this prevents: `ctx.sleep("nap", 60_000)` re-evaluated on every delivery
    // stores a deadline 60s later each time, and the run never wakes.
    const { journal } = await seed();
    const body = async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      await ctx.sleep("nap", 60_000);
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
    const body = async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      await ctx.sleep("nap", 60_000);
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
    // A step's key is `sleep#0` and a wait's is `sleep!<label>#0`, so the two cannot
    // alias however the author names their steps.
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      const value = await ctx.step("sleep", () => "a step, not a wait");
      await ctx.sleep("nap", 60_000);
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
      for (let i = 0; i < 2; i++) await ctx.sleep("round", 60_000);
      return "both";
    });
    expect(outcome.kind).toBe("suspended");
  });
});

describe("a hook answered while its own timeout is being read", () => {
  // `closeHook` used to be unconditional, so this walk took the TIMED-OUT branch
  // while every later replay read `delivered: true` and took the ANSWERED one —
  // the exact divergence `HookRecord.closed` is documented to prevent.

  test("both walks take the ANSWERED branch", async () => {
    const { journal } = await seed();
    const body = async (_input: Record<string, unknown>, ctx: WorkflowContext) => ({
      answer: await ctx.waitFor("tok", { timeoutMs: 1000 }),
    });

    const claimSleep = journal.claimSleep.bind(journal);
    const racing = vi
      .spyOn(journal, "claimSleep")
      .mockImplementation(async (runId, key, _wakeAt, correlationId, kind) => {
        // The deadline is ALREADY elapsed, and the signal lands between reading
        // it and closing the window — which is the whole race, and the only
        // instant in which the two branches disagree.
        const record = await claimSleep(runId, key, Date.now() - 1, correlationId, kind);
        if (key === "hookTimeout!tok#0") await journal.deliverHook("tok", { ok: true });
        return record;
      });

    const first = await replay(journal, body);
    racing.mockRestore();
    const second = await replay(journal, body);

    expect(first).toEqual({ kind: "completed", output: { answer: { ok: true } } });
    // The property, stated as the comparison: two walks of one body cannot
    // disagree about what happened.
    expect(second).toEqual(first);
  });

  test("still times out when nothing was delivered", async () => {
    const { journal } = await seed();
    const body = async (_input: Record<string, unknown>, ctx: WorkflowContext) => ({
      answer: await ctx.waitFor("tok", { timeoutMs: -1 }),
    });
    expect(await replay(journal, body)).toEqual({
      kind: "completed",
      output: { answer: undefined },
    });
    // And the window is shut, so a late signal cannot reopen it.
    expect(await journal.deliverHook("tok", { late: true })).toBeUndefined();
  });
});

/**
 * A journal write that FAILS is not the step's failure, and the distinction is
 * carried by one missing `await`.
 *
 * `attemptLoop` ends its success arm with a bare `return journal.appendStep(…)`
 * inside a `try`. The promise leaves the function unsettled, so the `catch`
 * cannot see its rejection — which is what keeps a database blip from being
 * classified as the body's own failure and retried. These pin the two halves of
 * that, because the property is invisible in the diff: adding `await` changes
 * nothing about the happy path and everything about this one.
 */
describe("a journal whose appendStep rejects", () => {
  /** A journal that stores runs and waits normally and cannot write a step. */
  function withBrokenAppend(journal: JournalStore, reason: string): JournalStore {
    return {
      ...journal,
      appendStep: () => Promise.reject(new Error(reason)),
    };
  }

  test("propagates out of replayRun rather than resolving a failed run", async () => {
    // The documented contract: a failure of the JOURNAL means the run's state is
    // unknown, so the delivery fails and is retried. Marking the run `failed` on
    // the strength of a write error is what must not happen.
    const { journal } = await seed();
    const broken = withBrokenAppend(journal, "connection reset");

    await expect(replay(broken, (_input, ctx) => ctx.step("work", () => 1))).rejects.toThrow(
      "connection reset",
    );
  });

  test("does NOT re-run the step body, which is what an `await` there would cost", async () => {
    // With `return await`, the rejection lands in the loop's own `catch`, reads
    // as an unclassified (therefore retryable) throw, and the body runs again —
    // `maxAttempts` times, re-doing whatever the step was paid to do.
    const { journal } = await seed();
    const paid = vi.fn(() => "receipt");
    const broken = withBrokenAppend(journal, "connection reset");

    await expect(
      replay(broken, (_input, ctx) => ctx.step("charge", paid, { maxAttempts: 3 })),
    ).rejects.toThrow("connection reset");
    expect(paid).toHaveBeenCalledTimes(1);
  });

  test("still propagates when the body SWALLOWS the rejection", async () => {
    // The quieter half, and worse here than for a refusal: the body caught the
    // store's error and answered, so the run would be marked `completed`
    // carrying a step the journal never recorded.
    const { journal } = await seed();
    const broken = withBrokenAppend(journal, "connection reset");

    await expect(
      replay(broken, async (_input, ctx) => {
        try {
          await ctx.step("work", () => 1);
        } catch {
          return "swallowed";
        }
        return "answered";
      }),
    ).rejects.toThrow("connection reset");
  });

  test("does the same for a WAIT's claim, not only for appendStep", async () => {
    // The reason this is a wrapper rather than a check at one call site: a
    // `claimSleep` rejection unwinds through the body exactly as an `appendStep`
    // one does, from a different file.
    const { journal } = await seed();
    const broken: JournalStore = {
      ...journal,
      claimSleep: () => Promise.reject(new Error("pool exhausted")),
    };

    await expect(replay(broken, (_input, ctx) => ctx.sleep("nap", 1000))).rejects.toThrow(
      "pool exhausted",
    );
  });

  test("writes no `failed` entry over a step whose body SUCCEEDED", async () => {
    // The sharper half. A journaled `failed` is authoritative forever, so the
    // step that really returned would replay as a failure for the life of the
    // run. Asserted against the REAL journal underneath the broken facade.
    const { journal } = await seed();
    const broken = withBrokenAppend(journal, "connection reset");

    await expect(replay(broken, (_input, ctx) => ctx.step("work", () => 1))).rejects.toThrow();
    expect(await journal.readSteps("wrun_1")).toEqual([]);
  });
});
