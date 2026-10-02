// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate under the gate: proof that the replay post-condition and the derived
 * journal invariants can FAIL.
 *
 * Everything in `workflow/journal/_log.ts`,
 * `workflow/journal/_invariants.ts` and `workflow/_engine-harness.ts`'s
 * `expectWorldSound` reports success by printing nothing, which is the shape of
 * failure this repo keeps paying for — a gate that stopped matching prints the
 * same green as a tree that is clean. `check-escape-hatches`, `guard-invariants`
 * and `check-test-assertions` all carry their own spec for the same reason, and
 * `packages/aai-templates/CLAUDE.md` argues it.
 *
 * Three things are pinned, across three specs:
 *
 * - **The hook is WIRED** (this file). `harness` registers the post-condition,
 *   and it really re-derives the runs a spec finished rather than skipping all
 *   of them. This is what the two engine suites do not floor — see that
 *   harness's module doc for why a per-file count floor is refused.
 * - **The post-condition CATCHES a journal that cannot re-derive its run**
 *   (this file). Demonstrated twice — a step whose journaled output came back changed, and a
 *   body that reads a clock outside `ctx.now`. Its BOUNDARY is pinned in the
 *   same block: a log missing a step entry passes, because replay simply does
 *   the work again.
 * - **Every derived invariant fires** (`journal/_invariants.test.ts`, with
 *   `rebuildJournal` in `journal/_log.test.ts`), each on a hand-written log
 *   that breaks exactly one of them, and none of them fires on a healthy log.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createdRuns,
  expectReplayable,
  expectWorldSound,
  harness,
  unwatchedHarness,
} from "./_engine-harness.ts";

describe("the post-condition is wired", () => {
  test("harness re-derives every run a spec finished", async () => {
    const world = harness({ digest: (input) => ({ echoed: input.topic }) });
    const runId = await world.engine.start("digest", [{ topic: "otters" }]);
    await world.engine.execute(runId);

    // The number is what proves the hook is not a no-op: `harness` runs this
    // same function on test teardown, and a version of it that skipped every
    // run would be invisible there.
    expect(await expectWorldSound(world)).toBe(1);
    expect(createdRuns(world.writes)).toEqual([runId]);
  });

  test("a run still parked is skipped, and says so when asked directly", async () => {
    const world = harness({
      digest: async (_input, ctx) => {
        await ctx.sleep("settle", 60_000);
        return "eventually";
      },
    });
    const runId = await world.engine.start("digest", [{}]);
    await world.engine.execute(runId);

    expect(await expectWorldSound(world)).toBe(0);
    await expect(expectReplayable(world, runId)).rejects.toThrow(/is running/);
  });

  test("it FAILS when a step's journaled output does not survive the round trip", async () => {
    // `unwatchedHarness`, because this test's teardown must not also run the
    // post-condition it is deliberately breaking.
    const world = unwatchedHarness({ digest: (_input, ctx) => ctx.step("work", () => "done") });
    const runId = await world.engine.start("digest", [{}]);
    await world.engine.execute(runId);
    expect(await expectWorldSound(world)).toBe(1);

    // A step whose stored output came back CHANGED is the bug class this exists
    // for, and the one `workflow/typed-json.ts` is written against: a backend
    // reaching for `JSON.stringify` turns a `Uint8Array` into an index map and
    // "the run resumes with garbage rather than failing". Nothing above the
    // journal notices, because the run still completes.
    const corrupted = world.writes.map((write) =>
      write.m === "appendStep" ? { ...write, entry: { ...write.entry, output: "garbage" } } : write,
    );
    await expect(expectReplayable({ ...world, writes: corrupted }, runId)).rejects.toThrow(
      /re-derived from its own journal/,
    );
  });

  test("a journal missing a step is still re-derivable, and that is the BOUNDARY", async () => {
    // Worth pinning because it is the obvious negative case and it does not
    // fail: drop a step entry and the replay simply does the work again,
    // reaching the same answer and re-journaling the same key. So what this
    // post-condition claims is that the ANSWER is re-derivable, never that the
    // work is not repeated — exactly-once is `workflow/replay.test.ts`'s claim,
    // and the two crash models are what drive it under interruption.
    const work = vi.fn(() => "done");
    const world = unwatchedHarness({ digest: (_input, ctx) => ctx.step("work", work) });
    const runId = await world.engine.start("digest", [{}]);
    await world.engine.execute(runId);

    const shortened = world.writes.filter((write) => write.m !== "appendStep");
    await expectReplayable({ ...world, writes: shortened }, runId);
    expect(work).toHaveBeenCalledTimes(2);
  });

  test("it FAILS when a body reads a clock outside ctx.now", async () => {
    // The documented blind spot, from the other side: an unjournaled read is
    // what makes the post-condition report a difference it cannot attribute, and
    // a spec is the one place `guard-invariants` rule 30 cannot see the body.
    const world = unwatchedHarness({ digest: () => ({ at: Math.random() }) });
    const runId = await world.engine.start("digest", [{}]);
    await world.engine.execute(runId);

    await expect(expectReplayable(world, runId)).rejects.toThrow(/re-derived from its own journal/);
  });
});

describe("the post-condition over the runtime's own suites", () => {
  test("holds for a run that fans out, retries and narrates", async () => {
    const flaky = vi.fn();
    let tries = 0;
    const world = harness({
      digest: async (_input, ctx) => {
        const [a, b] = await Promise.all([ctx.step("a", () => "A"), ctx.step("b", () => "B")]);
        const c = await ctx.step("c", () => {
          flaky();
          tries += 1;
          if (tries === 1) throw new Error("once");
          return "C";
        });
        return [a, b, c];
      },
    });
    const runId = await world.engine.start("digest", [{}]);
    expect(await world.engine.execute(runId)).toBe("completed");
    expect(await world.engine.readOutput(runId)).toEqual(["A", "B", "C"]);

    // The point: replaying the journal re-derives that answer WITHOUT running
    // the flaky body again, which is the exactly-once claim seen from outside.
    const calls = flaky.mock.calls.length;
    await expectReplayable(world, runId);
    expect(flaky).toHaveBeenCalledTimes(calls);
  });
});
