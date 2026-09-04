// Copyright 2026 the AAI authors. MIT license.
/**
 * A polling body's journal traffic is FLAT in the number of deliveries.
 *
 * The engine opens every walk with one `readSteps`, so a settled step is free;
 * waits had no such read, and every `ctx.sleep` a walk reached was its own
 * `claimSleep` round trip whose answer was almost always "that finished several
 * deliveries ago". A body that polls mints a NEW key per iteration —
 * `sleep!poll#0`, `sleep!poll#1`, … — so delivery N re-claimed N-1 finished
 * waits before it could do any work, and the cost of a delivery grew with the
 * number of deliveries rather than with the work left.
 *
 * Production, on a 34-segment transcription run: **2,675 journal POSTs in 25
 * minutes, rising +1 per delivery across 69 consecutive deliveries**, with the
 * gap between deliveries growing 11s → 37s in step with the count. The run never
 * completed. Every call succeeded, so what a log showed was a run getting slower.
 *
 * ## The two things this file has to establish, and why one is not enough
 *
 * The first is the SHAPE — claims per delivery must not grow — which is what
 * `workflow-replay-waits.ts`'s snapshot arm buys. A/B'd, and the numbers are the
 * measured ones: with that arm removed, `a poll loop's claimSleep count is FLAT`
 * reports `[1, 2, 3, 4, 5, 5]` against the flat `[1, 1, 1, 1, 1, 0]` it asserts,
 * and `costs O(N) claims, not O(N²)` reports 20 against 5.
 *
 * The second is that the snapshot is only ever read where it CANNOT be stale in
 * a way that matters. `claimSleep` is a claim rather than a read — it creates the
 * record when there is none — so the rule is narrower than the step one, and the
 * three cases below are its boundary: a first reach must still CREATE, a
 * future-dated unwoken wait must still round-trip, and a wake that lands after
 * the snapshot was taken must still be seen. A file that measured only the first
 * property would pass just as well against a walk that skipped every claim.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { harness } from "./_workflow-engine-harness.ts";
import type { JournalWrite } from "./_workflow-journal-log.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { replayRun } from "./workflow-replay.ts";

/** How many polls the body takes before it is done. */
const ROUNDS = 6;

/**
 * The shape the production run had: probe, and sleep until the next probe.
 *
 * `ctx.sleep`'s deadline is far out, so each iteration PARKS and the next
 * delivery is a fresh walk over every wait taken so far — which is the whole
 * subject. The loop counter is body state derived from journaled step results,
 * so a replay walks the identical sequence (the ordinary determinism rule).
 */
const pollingBody = async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
  for (let i = 0; ; i++) {
    const done = await ctx.step("probe", () => i >= ROUNDS - 1);
    if (done) return i;
    await ctx.sleep("poll", 60_000);
  }
};

/** How many `claimSleep` calls landed since `from`. */
function claimsSince(writes: readonly JournalWrite[], from: number): number {
  return writes.slice(from).filter((write) => write.m === "claimSleep").length;
}

describe("an elapsed wait is answered from the walk's snapshot", () => {
  test("a poll loop's claimSleep count is FLAT across deliveries", async () => {
    const world = harness({ poll: pollingBody });
    const runId = await world.engine.start("poll", [{}]);

    const perDelivery: number[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const before = world.writes.length;
      await world.engine.execute(runId);
      perDelivery.push(claimsSince(world.writes, before));
      // Cut the wait short so the next delivery walks past it. Only the NEWEST
      // sleep is outstanding — the earlier ones are already woken — so this is
      // always 1 until the body stops sleeping.
      await world.engine.wakeUp(runId, undefined);
    }

    // One claim per delivery: the NEW wait this walk reached. Every earlier one
    // is `woken` in the snapshot and costs nothing. The last delivery reaches no
    // wait at all — its probe answers `done` — hence the trailing 0.
    expect(perDelivery).toEqual([1, 1, 1, 1, 1, 0]);
    expect(await world.engine.getRun(runId)).toMatchObject({ status: "completed" });
  });

  test("the whole run costs O(N) claims, not O(N²)", async () => {
    const world = harness({ poll: pollingBody });
    const runId = await world.engine.start("poll", [{}]);
    for (let round = 0; round < ROUNDS; round++) {
      await world.engine.execute(runId);
      await world.engine.wakeUp(runId, undefined);
    }

    // ROUNDS - 1 waits, claimed once each. The quadratic version of this run
    // costs sum(1..ROUNDS-1) = 15, and a real one — 69 deliveries — costs 2,346.
    expect(claimsSince(world.writes, 0)).toBe(ROUNDS - 1);
    // And the SNAPSHOT is what pays for it: one bulk read per walk, whatever the
    // run has waited on. Asserted as a distinct claim so a future change that
    // made the read per-wait would fail here rather than merely getting slower.
    expect(await world.journal.readSleeps(runId)).toHaveLength(ROUNDS - 1);
  });
});

describe("what the snapshot may NOT answer", () => {
  test("a first reach still CREATES the wait, so a wake has something to find", async () => {
    // The snapshot is empty on the first walk, and answering from a MISS would
    // leave a wait no `wakeUp` and no reconcile can see — the run would report
    // itself waiting on nothing.
    const world = harness({
      digest: async (_input, ctx: WorkflowContext) => {
        await ctx.sleep("nap", 60_000);
        return "through";
      },
    });
    const runId = await world.engine.start("digest", [{}]);
    expect(await world.engine.execute(runId)).toBe("running");
    expect(await world.journal.readSleeps(runId)).toEqual([
      { key: "sleep!nap#0", wakeAt: expect.any(Number), woken: false, kind: "sleep" },
    ]);
    // Reachable BY NAME, which is the property a skipped claim destroys.
    expect(await world.engine.wakeUp(runId, undefined)).toBe(1);
    expect(await world.engine.execute(runId)).toBe("completed");
    world.settledOutOfBand(runId, "the wake is an external command, like a cancel");
  });

  test("a future-dated unwoken wait round-trips on EVERY delivery", async () => {
    // `woken` is the one field a wake changes, and a snapshot taken before one
    // cannot carry it. So a wait that is neither woken nor elapsed has to be
    // asked about again — the round trip the snapshot exists to remove is only
    // the one whose answer cannot change.
    const world = harness({
      digest: async (_input, ctx: WorkflowContext) => {
        await ctx.sleep("nap", 60_000);
        return "through";
      },
    });
    const runId = await world.engine.start("digest", [{}]);
    for (let delivery = 0; delivery < 3; delivery++) {
      const before = world.writes.length;
      expect(await world.engine.execute(runId)).toBe("running");
      expect(claimsSince(world.writes, before), `delivery ${delivery}`).toBe(1);
    }
    world.settledOutOfBand(runId, "still parked");
    await world.engine.cancel(runId);
  });

  test("a wake landing AFTER the snapshot was taken is not missed", async () => {
    // The sharp case, and the one the engine cannot stage on its own: a walk
    // reads its snapshot at the top and a `wakeUp` lands before the body gets to
    // the wait. `ReplayOptions.sleeps` is what makes it expressible — the
    // snapshot handed in here is deliberately one read BEFORE the wake, which is
    // the worst a real walk can hold.
    const journal = createMemoryJournal();
    await journal.createRun({
      runId: "wrun_stale",
      workflow: "digest",
      status: "running",
      createdAt: Date.now(),
      input: {},
    });
    await journal.claimSleep("wrun_stale", "sleep!nap#0", Date.now() + 60_000, undefined);
    const stale = await journal.readSleeps("wrun_stale");
    expect(stale).toMatchObject([{ key: "sleep!nap#0", woken: false }]);
    expect(await journal.wakeSleeps("wrun_stale", undefined)).toBe(1);

    const outcome = await replayRun({
      runId: "wrun_stale",
      workflow: "digest",
      input: {},
      journal,
      sleeps: Promise.resolve(stale),
      run: async (_input, ctx: WorkflowContext) => {
        await ctx.sleep("nap", 60_000);
        return "through";
      },
    });
    // Not `{ kind: "suspended" }`: the record was unwoken and future-dated in the
    // snapshot, so the reach round-tripped and read the wake. A snapshot that
    // answered a MISS or a not-yet-elapsed hit would park a run that had already
    // been told to go, and nothing would ever tell it again.
    expect(outcome).toEqual({ kind: "completed", output: "through" });
  });
});
