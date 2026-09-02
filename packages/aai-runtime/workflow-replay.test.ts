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
import { isWorkflowSuspend } from "@alexkroman1/aai";
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
  run: (input: Record<string, unknown>, ctx: WorkflowCtx) => Promise<unknown> | unknown,
  input: Record<string, unknown> = {},
) {
  return replayRun({ runId: "wrun_1", workflow: "digest", input, run, journal });
}

/**
 * Capture what the engine NARRATES for the duration of one test.
 *
 * The reporter slot is process-global (`sdk/step-report.ts`), so it is installed
 * and taken back down per test — and taking it down matters twice over: an
 * unpublished slot makes `report()` fall back to the console, which would put
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

describe("a body that swallows its own suspend", () => {
  // The severe case, and it shipped: `recap-workflow`'s saga wrapped its whole
  // body in a `try`/`catch` that unwound a compensation stack, so the first poll
  // that had to WAIT deleted the transcript the run was waiting for, journaled
  // the deletion as successful, and re-threw — and the engine, seeing its own
  // signal come back out, recorded the run as healthily suspended.

  test("fails the run rather than reporting the failure the body threw instead", async () => {
    const { journal } = await seed();
    const cleanup = vi.fn(() => "undone");
    const outcome = await replay(journal, async (_input, ctx) => {
      try {
        await ctx.sleep(60_000);
        return "unreachable";
      } catch (err) {
        // The shipped shape: cleanup, then throw something of its own. Carrying
        // the suspend as `cause` does NOT rescue it — the brand is on the cause,
        // not on what was thrown — which is the realistic version, since a body
        // wrapping an error is likelier than one discarding it.
        await ctx.step("cleanup", cleanup);
        throw new Error("recap failed", { cause: err });
      }
    });

    expect(outcome.kind).toBe("failed");
    // The message names the REMEDY, because the symptom is whatever the body did
    // next and the cause is one line in a `catch`.
    expect(outcome).toMatchObject({
      error: { message: expect.stringContaining("isWorkflowSuspend") },
    });
    // What the body threw is carried as CONTEXT rather than presented as the
    // run's cause — a reader needs both halves: the swallow is the bug, and the
    // error the body threw instead is how they will recognise their own code.
    expect(outcome).toMatchObject({
      error: { message: expect.stringContaining("threw: recap failed") },
    });
    // The cleanup DID run, which is exactly the damage being reported. Pinned so
    // nobody reads the guard as preventing it — it cannot, it can only refuse to
    // call the result healthy.
    expect(cleanup).toHaveBeenCalled();
  });

  test("fails the run when the body swallows it and returns a value", async () => {
    // The quieter half: the output would describe a run that skipped its wait.
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      try {
        await ctx.sleep(60_000);
      } catch {
        // Swallowed entirely.
      }
      return "as if it had waited";
    });

    expect(outcome.kind).toBe("failed");
    expect(outcome).toMatchObject({
      error: { message: expect.stringContaining("returned a value") },
    });
  });

  test("suspends normally when the catch re-throws it, which is the documented shape", async () => {
    const { journal } = await seed();
    const cleanup = vi.fn(() => "undone");
    const outcome = await replay(journal, async (_input, ctx) => {
      try {
        await ctx.sleep(60_000);
        return "later";
      } catch (err) {
        if (isWorkflowSuspend(err)) throw err;
        await ctx.step("cleanup", cleanup);
        throw err;
      }
    });

    expect(outcome.kind).toBe("suspended");
    // The failure path did NOT run — which is the whole point.
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("still lets a body catch a real STEP failure while a suspend is re-thrown", async () => {
    // The two must stay distinguishable, or the guard would make `try`/`catch`
    // useless in a body that also waits.
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      let recovered = "no";
      try {
        await ctx.step("flaky", () => {
          throw new FatalError("nope");
        });
      } catch (err) {
        if (isWorkflowSuspend(err)) throw err;
        recovered = "yes";
      }
      return recovered;
    });

    expect(outcome).toEqual({ kind: "completed", output: "yes" });
  });
});

describe("a suspend thrown from INSIDE a step", () => {
  // Out of contract — a step cannot wait, which is what makes it the unit this
  // engine can neither interrupt nor un-journal — and trivially reachable
  // anyway, because the closure a step is handed captures `ctx`. Before this the
  // attempt loop read a `SuspendSignal` as an ordinary retryable error: the body
  // ran once per attempt, each run minted a DISTINCT sleep record (the wait's
  // identity diverging with the counter), and the loop journaled
  // `{status: "failed", error: "workflow suspended"}` — an entry that is
  // authoritative forever, so every later replay answers the wait as a failure.

  test("propagates untouched, journaling nothing and running the body ONCE", async () => {
    const { journal } = await seed();
    const claimSleep = vi.spyOn(journal, "claimSleep");
    const waiting = vi.fn(async (ctx: WorkflowCtx) => {
      await ctx.sleep(60_000);
    });

    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("waiting", () => waiting(ctx)),
    );

    expect(outcome.kind).toBe("suspended");
    // Once, not once per attempt — and so ONE wait rather than `sleep!0/1/2`.
    expect(waiting).toHaveBeenCalledTimes(1);
    expect(claimSleep.mock.calls.map((call) => call[1])).toEqual(["sleep!0"]);
    // Nothing journaled. A `failed` entry here would answer the wait as a
    // failure on every replay from now on.
    expect(await journal.readSteps("wrun_1")).toEqual([]);
    // One attempt consumed by this delivery, not the whole budget: the next
    // claim is 2.
    expect(await journal.claimAttempt("wrun_1", "waiting#0")).toBe(2);
  });

  test("resumes on the next delivery instead of failing the run", async () => {
    const { journal } = await seed();
    const body = async (_input: Record<string, unknown>, ctx: WorkflowCtx) =>
      ctx.step("waiting", async () => {
        await ctx.sleep(60_000);
        return "waited";
      });

    expect((await replay(journal, body)).kind).toBe("suspended");
    expect(await journal.wakeSleeps("wrun_1", undefined)).toBe(1);
    // The SAME wait key, so the wake reaches it and the step settles.
    expect(await replay(journal, body)).toEqual({ kind: "completed", output: "waited" });
  });
});

describe("a hook answered while its own timeout is being read", () => {
  // `closeHook` used to be unconditional, so this walk took the TIMED-OUT branch
  // while every later replay read `delivered: true` and took the ANSWERED one —
  // the exact divergence `HookRecord.closed` is documented to prevent.

  test("both walks take the ANSWERED branch", async () => {
    const { journal } = await seed();
    const body = async (_input: Record<string, unknown>, ctx: WorkflowCtx) => ({
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
        if (key === "hookTimeout!0") await journal.deliverHook("tok", { ok: true });
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
    const body = async (_input: Record<string, unknown>, ctx: WorkflowCtx) => ({
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
