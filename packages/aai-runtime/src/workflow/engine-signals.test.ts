// Copyright 2026 the AAI authors. MIT license.
/**
 * Signals derived from the run key, held signals, and the run's timing, through
 * the engine: a start with a key journals it, the body reads it back, a signal
 * for the derived token resumes the run — before or after the wait is reached
 * — and the snapshot says when the run started and settled.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import { DEFAULT_SIGNAL_HOLD_MS } from "@alexkroman1/aai/workflow-api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { harness } from "./_engine-harness.ts";
import { clearHeldSignals, heldSignalCount, takeHeldSignal } from "./held-signals.ts";

afterEach(clearHeldSignals);

describe("a run started with a key", () => {
  test("journals it, and the body reads it as ctx.key on every walk", async () => {
    const seen: (string | undefined)[] = [];
    const world = harness({
      digest: async (_input, ctx: WorkflowContext) => {
        seen.push(ctx.key);
        await ctx.sleep("nap", 60_000);
        seen.push(ctx.key);
        return "done";
      },
    });
    const runId = await world.engine.start("digest", [{}], { key: "sess-1" });
    expect((await world.journal.readSteps(runId)).map((s) => s.key)).toEqual(["key!"]);
    expect(await world.engine.execute(runId)).toBe("running");
    await world.engine.wakeUp(runId, undefined);
    expect(await world.engine.execute(runId)).toBe("completed");
    expect(seen).toEqual(["sess-1", "sess-1", "sess-1"]);
  });

  test("runs the caller's key-INDEX write before the id is handed back, loser of a dedupe included", async () => {
    const world = harness({ digest: async () => "done" });
    const index = vi.fn(async (_runId: string) => undefined);
    const runId = await world.engine.start("digest", [{}], {
      key: "sess-1",
      dedupeKey: "evt_1",
      index,
    });
    expect(index).toHaveBeenCalledWith(runId);
    // The loser is answering for the same run, and its caller still has to be
    // able to find it by key — the index is idempotent on the id.
    expect(
      await world.engine.start("digest", [{}], { key: "sess-1", dedupeKey: "evt_1", index }),
    ).toBe(runId);
    expect(index).toHaveBeenCalledTimes(2);
    // The journaling of the key is not displaced by the index riding beside it.
    expect((await world.journal.readSteps(runId)).map((s) => s.key)).toEqual(["key!"]);
  });

  test("a run started without one reads `undefined`, and signalToken refuses", async () => {
    const world = harness({
      digest: async (_input, ctx: WorkflowContext) => {
        expect(ctx.key).toBeUndefined();
        expect(() => ctx.signalToken("x")).toThrow(/has no key/);
        return "done";
      },
    });
    const runId = await world.engine.start("digest", [{}]);
    expect(await world.engine.execute(runId)).toBe("completed");
  });
});

describe("ctx.waitForSignal", () => {
  const body = async (_input: unknown, ctx: WorkflowContext) => {
    const answer = await ctx.waitForSignal<{ approved: boolean }>("approval");
    return answer.approved ? "published" : "shelved";
  };

  test("parks on `<workflow>:<key>:<label>`, and a signal for that token resumes it", async () => {
    const world = harness({ digest: body });
    const runId = await world.engine.start("digest", [{}], { key: "sess-1" });
    expect(await world.engine.execute(runId)).toBe("running");
    expect(await world.engine.signal("digest:sess-1:approval", { approved: true })).toBe(true);
    expect(await world.engine.execute(runId)).toBe("completed");
    expect(await world.engine.readOutput(runId)).toBe("published");
  });

  test("a second run under the SAME key fails at the wait, naming the label, the key and the fix", async () => {
    // The token carries no run component, so "run it again" in one session
    // derives the token the first run still holds. The journal's sentence
    // names the token; the engine's names what to change.
    const world = harness({ digest: body });
    const first = await world.engine.start("digest", [{}], { key: "sess-1" });
    expect(await world.engine.execute(first)).toBe("running");
    const second = await world.engine.start("digest", [{}], { key: "sess-1" });
    expect(await world.engine.execute(second)).toBe("failed");
    const { error } = (await world.engine.getRun(second)) ?? {};
    expect(error?.message).toContain(`"digest:sess-1:approval" is already held by run ${first}`);
    expect(error?.message).toContain(
      'This run of "digest" under key "sess-1" reached ctx.waitForSignal("approval")',
    );
    expect(error?.message).toContain("A second concurrent run needs a distinct StartOptions.key");
    // The first run is untouched by the collision: its wait still answers.
    expect(await world.engine.signal("digest:sess-1:approval", { approved: true })).toBe(true);
    expect(await world.engine.execute(first)).toBe("completed");
  });

  test("an infinite hold is clamped to the default window rather than kept for the life of the process", async () => {
    vi.useFakeTimers();
    try {
      const world = harness({ digest: body });
      expect(
        await world.engine.signal(
          "digest:sess-1:approval",
          { approved: true },
          { holdMs: Number.POSITIVE_INFINITY },
        ),
      ).toBe(true);
      expect(heldSignalCount()).toBe(1);
      vi.setSystemTime(Date.now() + DEFAULT_SIGNAL_HOLD_MS + 1);
      // Past the default window the hold is gone — an `Infinity` expiry never
      // was, and every later run under the key would have taken it.
      expect(takeHeldSignal("digest:sess-1:approval")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a signal sent BEFORE the wait is reached is lost without a hold, and kept with one", async () => {
    const world = harness({ digest: body });
    const runId = await world.engine.start("digest", [{}], { key: "sess-1" });
    expect(await world.engine.signal("digest:sess-1:approval", { approved: false })).toBe(false);
    expect(
      await world.engine.signal("digest:sess-1:approval", { approved: true }, { holdMs: 60_000 }),
    ).toBe(true);
    // The held payload is delivered when the wait is claimed, through the
    // journal: the hook reads `delivered` like any answered wait.
    expect(await world.engine.execute(runId)).toBe("completed");
    expect(await world.engine.readOutput(runId)).toBe("published");
  });

  test("a hold stored AFTER the wait claimed and looked is retried, not parked on forever", async () => {
    // The interleaving: `signal`'s `deliverHook` misses (the hook is not
    // claimed yet), then — before `signal` goes on to store the hold — the body
    // reaches its wait, claims the hook, finds nothing held and parks. Forced by
    // holding `signal` at the gap: the FIRST delivery's answer is handed back
    // only once the test lets it go.
    const gap = Promise.withResolvers<void>();
    let misses = 0;
    const world = harness({ digest: body }, vi.fn(), (journal) => ({
      ...journal,
      async deliverHook(token, payload) {
        const woke = await journal.deliverHook(token, payload);
        if (woke === undefined && misses++ === 0) await gap.promise;
        return woke;
      },
    }));
    const runId = await world.engine.start("digest", [{}], { key: "sess-1" });
    const signalled = world.engine.signal(
      "digest:sess-1:approval",
      { approved: true },
      { holdMs: 60_000 },
    );
    // The wait claims while the signal is parked at the gap, and parks the run.
    expect(await world.engine.execute(runId)).toBe("running");
    gap.resolve();
    expect(await signalled).toBe(true);
    // `true` has to mean TAKEN: the run was re-dispatched to read the answer,
    // and no hold is left behind for a wait that will never come.
    expect(world.dispatch).toHaveBeenCalledWith(runId);
    expect(heldSignalCount()).toBe(0);
    expect(await world.engine.execute(runId)).toBe("completed");
    expect(await world.engine.readOutput(runId)).toBe("published");
  });

  test("a hold of zero is no hold", async () => {
    const world = harness({ digest: body });
    await world.engine.start("digest", [{}], { key: "sess-1" });
    expect(await world.engine.signal("digest:sess-1:approval", {}, { holdMs: 0 })).toBe(false);
  });
});

describe("a sleep's correlation id", () => {
  test("defaults to its label, so a wake by label ends it", async () => {
    const world = harness({
      digest: async (_input, ctx: WorkflowContext) => {
        await ctx.sleep("review-window", 60_000);
        return "sent";
      },
    });
    const runId = await world.engine.start("digest", [{}]);
    expect(await world.engine.execute(runId)).toBe("running");
    expect(await world.engine.wakeUp(runId, ["something-else"])).toBe(0);
    expect(await world.engine.wakeUp(runId, ["review-window"])).toBe(1);
  });
});

describe("run timing", () => {
  test("startedAt is the FIRST delivery's, and settledAt the terminal write's", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const world = harness({
        digest: async (_input, ctx: WorkflowContext) => {
          await ctx.sleep("nap", 60_000);
          return "done";
        },
      });
      const runId = await world.engine.start("digest", [{}]);
      expect(await world.engine.getRun(runId)).not.toHaveProperty("startedAt");
      vi.setSystemTime(2000);
      expect(await world.engine.execute(runId)).toBe("running");
      expect(await world.engine.getRun(runId)).toMatchObject({ startedAt: 2000 });
      vi.setSystemTime(3000);
      await world.engine.wakeUp(runId, undefined);
      expect(await world.engine.execute(runId)).toBe("completed");
      // A second delivery re-announced `running` and did not move the start.
      expect(await world.engine.getRun(runId)).toMatchObject({ startedAt: 2000, settledAt: 3000 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a cancel settles the run too", async () => {
    const world = harness({
      digest: async (_input, ctx: WorkflowContext) => {
        await ctx.sleep("nap", 60_000);
        return "done";
      },
    });
    const runId = await world.engine.start("digest", [{}]);
    await world.engine.execute(runId);
    expect(await world.engine.cancel(runId)).toBe(true);
    expect((await world.engine.getRun(runId))?.settledAt).toEqual(expect.any(Number));
  });
});
