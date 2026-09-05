// Copyright 2026 the AAI authors. MIT license.
/**
 * A suspension is out of band, and concurrent waits are AGGREGATED.
 *
 * The spec for `workflow-replay-suspend.ts`, driven through `replayRun` rather
 * than against the controller directly — every claim here is about what a BODY
 * can and cannot do, so the only honest subject is a body walked by the real
 * engine.
 *
 * Split out of `workflow-replay.test.ts` at the 700-line cap, along the seam the
 * module split already drew.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { FatalError } from "@alexkroman1/aai/step-errors";
import { describe, expect, test, vi } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore, RunRecord } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";

/** Long enough that no wait a test reaches can elapse under it. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
  run: (input: Record<string, unknown>, ctx: WorkflowContext) => Promise<unknown> | unknown,
) {
  return replayRun({ runId: "wrun_1", workflow: "digest", input: {}, run, journal });
}

describe("a body that tries to observe its own suspend", () => {
  // The severe case, and it shipped: `recap-workflow`'s saga wrapped its whole
  // body in a `try`/`catch` that unwound a compensation stack, so the first poll
  // that had to WAIT deleted the transcript the run was waiting for, journaled
  // the deletion as successful, and re-threw — and the engine, seeing its own
  // signal come back out, recorded the run as healthily suspended.
  //
  // Every test here USED to be a test of the two defences against that (a
  // predicate a body's `catch` had to remember, and a post-hoc check that
  // FAILED a run whose body forgot). They are now tests that the body cannot
  // observe a suspension at all: a wait hands back a promise that never
  // settles, so none of these `catch`/`finally` bodies runs.

  test("a catch that would swallow it never runs — the run SUSPENDS", async () => {
    const { journal } = await seed();
    const cleanup = vi.fn(() => "undone");
    const outcome = await replay(journal, async (_input, ctx) => {
      try {
        await ctx.sleep("week", 60_000);
        return "unreachable";
      } catch {
        // The shipped shape: cleanup, then an answer of its own. Under the throw
        // this ran, deleted the data and reported `failed`.
        await ctx.step("cleanup", cleanup);
        return "swallowed";
      }
    });

    expect(outcome).toEqual({ kind: "suspended", wakeAt: expect.any(Number) });
    // The damage the old defences could only REPORT is now not done at all.
    expect(cleanup).not.toHaveBeenCalled();
    expect(await journal.readSteps("wrun_1")).toEqual([]);
  });

  test("a finally that decides the answer never runs either", async () => {
    // The nastier shape, and the one no predicate could EVER have defended: a
    // `finally` runs whether or not a `catch` re-threw, so a body that decided
    // its own answer there swallowed the suspension no matter how carefully its
    // `catch` was written. It only runs on completion of the `try`, and a parked
    // wait never completes.
    //
    // The literal spelling is `finally { return "…" }`, which Biome's
    // `noUnsafeFinally` refuses; the assignment below is the same fact, and the
    // SPY is what discriminates — under the throw this reassigned `answer` and
    // then let the suspension past, so the outcome alone reported `suspended`
    // either way and pinned nothing.
    const { journal } = await seed();
    const decide = vi.fn(() => "decided in finally");
    const outcome = await replay(journal, async (_input, ctx) => {
      let answer = "unreachable";
      try {
        await ctx.sleep("week", 60_000);
        answer = "waited";
      } finally {
        answer = decide();
      }
      return answer;
    });

    expect(decide).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "suspended", wakeAt: expect.any(Number) });
  });

  test("nothing after the wait runs, so no later step is journaled", async () => {
    const { journal } = await seed();
    const after = vi.fn(() => "later");
    const outcome = await replay(journal, async (_input, ctx) => {
      await ctx.sleep("week", 60_000);
      return ctx.step("after", after);
    });

    expect(outcome.kind).toBe("suspended");
    expect(after).not.toHaveBeenCalled();
  });

  test("still lets a body catch a real STEP failure", async () => {
    // The other half: `try`/`catch` in a body has to keep WORKING, and it is
    // ordinary now — it sees step failures and nothing else, with no predicate
    // to remember.
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      let recovered = "no";
      try {
        await ctx.step("flaky", () => {
          throw new FatalError("nope");
        });
      } catch {
        recovered = "yes";
      }
      return recovered;
    });

    expect(outcome).toEqual({ kind: "completed", output: "yes" });
  });
});

describe("concurrent waits are aggregated into ONE suspension", () => {
  // The composition a throw could not express: it stopped the body at the FIRST
  // unelapsed wait, so a `Promise.race` over two waits suspended on whichever
  // was reached first and the other was never journaled at all.

  test("a race over two sleeps wakes at the EARLIER deadline", async () => {
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      await Promise.race([ctx.sleep("far", WEEK_MS), ctx.sleep("near", 1000)]);
      return "raced";
    });

    expect(outcome.kind).toBe("suspended");
    // Both waits were REACHED and journaled, and the wake is the near one. Under
    // the throw this reported the WEEK and the second wait did not exist.
    // Read back by LABEL — the keys name the waits, so this no longer depends
    // on which arm of the race the walk happened to reach first.
    const [near, far] = await Promise.all([
      journal.claimSleep("wrun_1", "sleep!near#0", Date.now() + 999_999, undefined),
      journal.claimSleep("wrun_1", "sleep!far#0", Date.now() + 999_999, undefined),
    ]);
    expect(outcome).toEqual({ kind: "suspended", wakeAt: near.wakeAt });
    expect(far.wakeAt).toBeGreaterThan(near.wakeAt);
  });

  test("an all over two sleeps wakes at the earlier one too, then parks on the rest", async () => {
    // `all` needs both, so the earlier wake is not the end of the wait — it is
    // the next delivery, which walks past the elapsed one and parks again on
    // what is left. Driven here by waking only the near wait.
    const { journal } = await seed();
    const body = async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      await Promise.all([
        ctx.sleep("far", WEEK_MS),
        ctx.sleep("near", 1000, { correlationId: "near" }),
      ]);
      return "both";
    };

    const first = await replay(journal, body);
    expect(first.kind).toBe("suspended");
    expect(await journal.wakeSleeps("wrun_1", ["near"])).toBe(1);

    const second = await replay(journal, body);
    // Still suspended, and now on the WEEK — which is what "aggregate the
    // OUTSTANDING waits" means: a settled one contributes nothing.
    const week = await journal.claimSleep("wrun_1", "sleep!far#0", Date.now() + 999_999, undefined);
    expect(second).toEqual({ kind: "suspended", wakeAt: week.wakeAt });
  });

  test("a hook contributes no wake time, so a sleep beside it decides", async () => {
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      await Promise.race([ctx.waitFor("tok_gate"), ctx.sleep("near", 1000)]);
      return "raced";
    });

    const stored = await journal.claimSleep(
      "wrun_1",
      "sleep!near#0",
      Date.now() + 999_999,
      undefined,
    );
    expect(outcome).toEqual({ kind: "suspended", wakeAt: stored.wakeAt });
  });

  test("two untimed hooks suspend with NO wake time at all", async () => {
    // `undefined` is what tells the caller not to schedule a delivery: both are
    // ended by a signal, so polling would wake a run that may be parked for a
    // week. See `ReplayOutcome`.
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      await Promise.race([ctx.waitFor("tok_a"), ctx.waitFor("tok_b")]);
      return "raced";
    });

    expect(outcome).toEqual({ kind: "suspended", wakeAt: undefined });
    // And BOTH tokens are registered, which is what makes either signal able to
    // move the run.
    expect(await journal.deliverHook("tok_a", { ok: "a" })).toBe("wrun_1");
    expect(await journal.deliverHook("tok_b", { ok: "b" })).toBe("wrun_1");
  });

  test("a step in flight beside a parked wait is journaled BEFORE the suspension", async () => {
    // QUIESCENCE, and the reason the suspension is not raised at the first park:
    // the step would go unjournaled and the next delivery would run it again.
    const { journal } = await seed();
    const work = vi.fn(async () => {
      await sleep(5);
      return "done";
    });
    const outcome = await replay(journal, async (_input, ctx) => {
      await Promise.all([ctx.sleep("week", WEEK_MS), ctx.step("slow", work)]);
      return "both";
    });

    expect(outcome.kind).toBe("suspended");
    expect(work).toHaveBeenCalledTimes(1);
    expect((await journal.readSteps("wrun_1")).map((s) => [s.key, s.output])).toEqual([
      ["slow#0", "done"],
    ]);
  });

  test("a determinism read in flight beside a parked wait is journaled too", async () => {
    // `ctx.now`/`random`/`uuid` are engine operations like a step: each awaits
    // its own `appendStep`, so a suspension raised out from under one would
    // leave the read unjournaled — and a process that then died would produce a
    // DIFFERENT value for the same key on the next delivery.
    //
    // The write has to be SLOW to discriminate. Against the memory journal it
    // settles inside the microtask drain `process.nextTick` already waits out,
    // so an unheld read is journaled anyway and the test would pass either way.
    const { journal } = await seed();
    const append = journal.appendStep.bind(journal);
    vi.spyOn(journal, "appendStep").mockImplementation(async (runId, entry) => {
      await sleep(5);
      return append(runId, entry);
    });

    const outcome = await replay(journal, async (_input, ctx) => {
      await Promise.all([ctx.sleep("week", WEEK_MS), ctx.uuid()]);
      return "both";
    });

    expect(outcome.kind).toBe("suspended");
    expect((await journal.readSteps("wrun_1")).map((s) => s.key)).toEqual(["uuid!0"]);
  });

  test("a body that RACES work against a wait completes when the work wins", async () => {
    // The other side of composition, and a shape the throw could not express at
    // all: it rejected the race the moment the wait was reached, so the work
    // never got to win. Now the wait simply parks, the step answers, and the run
    // is COMPLETE with one journaled wait nobody is waiting on — which is the
    // honest reading of a body that asked for whichever came first.
    const { journal } = await seed();
    const outcome = await replay(journal, async (_input, ctx) =>
      Promise.race([ctx.sleep("week", WEEK_MS), ctx.step("fast", () => "work won")]),
    );

    expect(outcome).toEqual({ kind: "completed", output: "work won" });
  });
});
