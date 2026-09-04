// Copyright 2026 the AAI authors. MIT license.
/**
 * A run that PARKS: what suspends it, and what brings it back.
 *
 * The other half of `workflow-engine.test.ts`, split off when that file crossed
 * the 700-line test cap, at the seam it already had. Three ways a run stops
 * without ending — a durable `sleep`, a `waitFor` with no deadline, and one with
 * a deadline — and they share a shape worth stating in one place: the wait is
 * journaled, so the DECISION is made once and a replay reads it rather than
 * making it again. A deadline recomputed per replay is a window that never
 * closes, and a wake that cannot tell a schedule from an approval cancels
 * something the body never asked to cancel.
 */

import { type WorkflowContext, workflow } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { harness } from "./_workflow-engine-harness.ts";
import { createWorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { createMemoryStreams } from "./workflow-streams.ts";

describe("durable sleep", () => {
  test("leaves a suspended run `running` and schedules its next delivery", async () => {
    // Not a terminal state and not `pending`: the run IS in progress, it is just
    // not executing. That is the status a caller polling it should see.
    const { engine, dispatch } = harness({
      digest: async (_input, ctx) => {
        await ctx.sleep("nap", 60_000);
        return "eventually";
      },
    });
    const runId = await engine.start("digest", [{}]);
    dispatch.mockClear();

    expect(await engine.execute(runId)).toBe("running");
    expect(await engine.getRun(runId)).toMatchObject({ status: "running" });
    const [id, at] = dispatch.mock.calls[0] ?? [];
    expect(id).toBe(runId);
    expect(at).toBeGreaterThan(Date.now());
  });

  test("does not re-dispatch a run cancelled while it was waiting", async () => {
    const { engine, journal, dispatch } = harness({
      digest: async (_input, ctx) => {
        await journal.setStatus("wrun_1", "cancelled", undefined, ["running"]);
        await ctx.sleep("nap", 60_000);
        return "unreachable";
      },
    });
    const runId = await engine.start("digest", [{}]);
    dispatch.mockClear();
    expect(await engine.execute(runId)).toBe("cancelled");
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("wake ends the wait, reports how many it stopped, and re-delivers", async () => {
    const after = vi.fn(() => "ran");
    const { engine, dispatch } = harness({
      digest: async (_input, ctx) => {
        await ctx.sleep("nap", 60_000);
        return ctx.step("after", after);
      },
    });
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    dispatch.mockClear();

    expect(await engine.wakeUp(runId, undefined)).toBe(1);
    // Re-delivered so the woken body actually continues, rather than waiting out
    // the deadline it was just told to skip.
    expect(dispatch).toHaveBeenCalledWith(runId);
    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.readOutput(runId)).toBe("ran");
  });

  test("a wake on a run that is not waiting reports 0 and costs no delivery", async () => {
    const { engine, dispatch } = harness({ digest: () => "done" });
    const runId = await engine.start("digest", [{}]);
    dispatch.mockClear();
    expect(await engine.wakeUp(runId, undefined)).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a wake on a run that never existed reports 0", async () => {
    const { engine } = harness();
    expect(await engine.wakeUp("wrun_nope", undefined)).toBe(0);
  });

  test("a wake naming a correlation id ends only that wait", async () => {
    const { engine } = harness({
      digest: async (_input, ctx) => {
        await ctx.sleep("review", 60_000, { correlationId: "review" });
        return "published";
      },
    });
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    expect(await engine.wakeUp(runId, ["something-else"])).toBe(0);
    expect(await engine.wakeUp(runId, ["review"])).toBe(1);
  });

  test("resumes past the wait once its deadline has passed, with no wake", async () => {
    const { engine } = harness({
      digest: async (_input, ctx) => {
        // Already elapsed, so the second delivery walks straight through.
        await ctx.sleep("past", -1);
        return "through";
      },
    });
    const runId = await engine.start("digest", [{}]);
    expect(await engine.execute(runId)).toBe("completed");
  });
});

describe("hooks", () => {
  /** A body that parks on one token and reports what it was sent. */
  const parking = {
    digest: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      const answer = await ctx.waitFor<{ approved: boolean }>("tok_review");
      return { approved: answer.approved };
    },
  };

  test("parks the body with NO next delivery scheduled", async () => {
    // The property that distinguishes a hook from a sleep: nothing but a signal
    // ends it, so scheduling a delivery would poll a run parked for a week.
    const { engine, dispatch } = harness(parking);
    const runId = await engine.start("digest", [{}]);
    dispatch.mockClear();

    expect(await engine.execute(runId)).toBe("running");
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a signal delivers the payload, re-delivers the run, and it completes", async () => {
    const { engine, dispatch } = harness(parking);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    dispatch.mockClear();

    expect(await engine.signal("tok_review", { approved: true })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(runId);
    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.readOutput(runId)).toEqual({ approved: true });
  });

  test("reports false for a token nothing holds", async () => {
    const { engine } = harness(parking);
    expect(await engine.signal("tok_nobody_is_waiting", {})).toBe(false);
  });

  test("reports false for a second signal on the same token", async () => {
    // A body is replayed and must read the FIRST payload every time, or two
    // walks of it diverge. So the second signal is not a second resolution.
    const { engine } = harness(parking);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    expect(await engine.signal("tok_review", { approved: true })).toBe(true);
    expect(await engine.signal("tok_review", { approved: false })).toBe(false);
    await engine.execute(runId);
    expect(await engine.readOutput(runId)).toEqual({ approved: true });
  });

  test("reports false for a token whose run already finished", async () => {
    // The ORDINARY case rather than an error: the run moved past its wait.
    const { engine } = harness(parking);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    await engine.signal("tok_review", { approved: true });
    await engine.execute(runId);
    expect(await engine.getRun(runId)).toMatchObject({ status: "completed" });
    expect(await engine.signal("tok_review", { approved: true })).toBe(false);
  });

  test("frees a DERIVED token when its run ends, so the next run can reuse it", async () => {
    // The SDK tells authors to derive a hook token from the run's own input, and
    // `recap-workflow` derives `retention:<sessionId>` — so a token that outlived
    // its run could serve exactly ONE run ever. A caller asking for a second
    // recap in one session hit `claimHook`'s conflict, which is NOT a suspend, so
    // the saga's catch compensated and deleted that transcript too.
    const { engine } = harness(parking);
    const first = await engine.start("digest", [{}]);
    await engine.execute(first);
    await engine.signal("tok_review", { approved: true });
    await engine.execute(first);
    expect(await engine.getRun(first)).toMatchObject({ status: "completed" });

    // Same token, second run — the ordinary shape, not an edge case.
    const second = await engine.start("digest", [{}]);
    expect(await engine.execute(second)).toBe("running");
    expect(await engine.signal("tok_review", { approved: false })).toBe(true);
    await engine.execute(second);
    expect(await engine.readOutput(second)).toEqual({ approved: false });
  });

  test("frees the token on a run that FAILED too, not only one that completed", async () => {
    const world = harness(parking);
    const { engine, journal } = world;
    const first = await engine.start("digest", [{}]);
    await engine.execute(first);
    await journal.setStatus(first, "failed", { error: { message: "gave up" } }, ["running"]);
    // Written here rather than by a walk, so no replay of this journal can reach
    // it — the body parks on its hook forever. See `settledOutOfBand`.
    world.settledOutOfBand(
      first,
      "the spec fails the run directly, standing in for a body that threw",
    );

    const second = await engine.start("digest", [{}]);
    expect(await engine.execute(second)).toBe("running");
    expect(await engine.signal("tok_review", { approved: true })).toBe(true);
  });

  test("fails a run whose token another LIVE run already holds", async () => {
    // One signal would resolve whichever wait the store found first and the
    // other would never end, so it is a bug worth failing the run over.
    const { engine } = harness({ ...parking, second: parking.digest });
    const first = await engine.start("digest", [{}]);
    await engine.execute(first);
    const clash = await engine.start("second", [{}]);
    expect(await engine.execute(clash)).toBe("failed");
    expect(await engine.getRun(clash)).toMatchObject({
      error: { message: expect.stringContaining("already held by") },
    });
  });

  test("a body may wait on a hook AFTER a step, resuming past the step", async () => {
    const work = vi.fn(() => "researched");
    const { engine } = harness({
      digest: async (_input, ctx) => {
        const notes = await ctx.step("research", work);
        const answer = await ctx.waitFor<{ ok: boolean }>("tok_gate");
        return { notes, ok: answer.ok };
      },
    });
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    await engine.signal("tok_gate", { ok: true });
    expect(await engine.execute(runId)).toBe("completed");
    // The step is answered from the journal on the resume, not re-run.
    expect(work).toHaveBeenCalledTimes(1);
    expect(await engine.readOutput(runId)).toEqual({ notes: "researched", ok: true });
  });
});

describe("a hook with a deadline", () => {
  /** A body that waits for an answer but not forever — Temporal's `timeoutOrUserAction`. */
  const gated = {
    digest: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      const answer = await ctx.waitFor<{ keep: boolean }>("tok_gate", { timeoutMs: 60_000 });
      return { kept: answer?.keep ?? false, answered: answer !== undefined };
    },
  };

  /** The same gate with a window short enough for a spec to outlive. */
  const briefly = {
    digest: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      const answer = await ctx.waitFor<{ keep: boolean }>("tok_gate", { timeoutMs: 1 });
      return { kept: answer?.keep ?? false, answered: answer !== undefined };
    },
  };

  test("suspends with the deadline scheduled, so an unanswered window still ends", async () => {
    // The difference from an unbounded wait: THIS one schedules a delivery,
    // because the window closing is an event the engine owns.
    const { engine, dispatch } = harness(gated);
    const runId = await engine.start("digest", [{}]);
    dispatch.mockClear();

    expect(await engine.execute(runId)).toBe("running");
    const [id, at] = dispatch.mock.calls[0] ?? [];
    expect(id).toBe(runId);
    expect(at).toBeGreaterThan(Date.now());
  });

  test("an answer inside the window wins", async () => {
    const { engine } = harness(gated);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    expect(await engine.signal("tok_gate", { keep: true })).toBe(true);
    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.readOutput(runId)).toEqual({ kept: true, answered: true });
  });

  test("a closed window resolves undefined, so the body takes its safe default", async () => {
    // `undefined` rather than a throw: a window closing is an outcome a body
    // branches on. The deadline is let ELAPSE rather than woken, because a bare
    // wake deliberately no longer reaches a hook's deadline — see below.
    const { engine } = harness(briefly);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    await sleep(5);

    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.readOutput(runId)).toEqual({ kept: false, answered: false });
  });

  test("a bare wakeUp does NOT close the window — it is for schedules, not approvals", async () => {
    // The hook's deadline is journaled through the same primitive as a
    // `ctx.sleep`, and without a `kind` on the record the two were
    // indistinguishable: a "send it now" tool calling `wakeUp(runId)` to cut a
    // SCHEDULE short also closed any pending approval window on that run — a
    // body cancelling a human approval it never asked to cancel.
    const { engine } = harness(gated);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);

    expect(await engine.wakeUp(runId, undefined)).toBe(0);
    // Still parked, so the answer can still arrive.
    expect(await engine.getRun(runId)).toMatchObject({ status: "running" });
    expect(await engine.signal("tok_gate", { keep: true })).toBe(true);
    await engine.execute(runId);
    expect(await engine.readOutput(runId)).toEqual({ kept: true, answered: true });
  });

  test("a signal that arrives after the window closed is refused", async () => {
    // So a caller cannot be told their answer was taken when it was not — and,
    // more to the point, so the next replay cannot read a payload and take the
    // answered branch after the body already took the other one.
    const { engine } = harness(briefly);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    await sleep(5);
    await engine.execute(runId);

    expect(await engine.signal("tok_gate", { keep: true })).toBe(false);
  });

  test("the deadline is decided ONCE, so a replay cannot extend the window", async () => {
    const journal = createMemoryJournal();
    const engine = createWorkflowEngine({
      workflows: { digest: workflow({ description: "d", run: gated.digest }) },
      journal,
      streams: createMemoryStreams(),
      dispatch: () => undefined,
      newRunId: () => "wrun_1",
      logger: silentLogger,
    });
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    const first = await journal.claimSleep(runId, "hookTimeout!0", 0, undefined);
    await engine.execute(runId);
    const second = await journal.claimSleep(runId, "hookTimeout!0", 0, undefined);
    expect(second.wakeAt).toBe(first.wakeAt);
  });
});
