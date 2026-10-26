// Copyright 2026 the AAI authors. MIT license.
/**
 * The handle's `signal` and `signalRun` mirror `ctx.workflows`' calls: an
 * absent payload is `{}`, `signalRun` HOLDS by default for a wait the body has
 * not reached, `signal` holds only when asked, and a hold is dropped with the
 * handle.
 */

import { type WorkflowContext, workflow } from "@alexkroman1/aai";
import { afterEach, describe, expect, test } from "vitest";
import { clearHeldSignals, heldSignalCount } from "../workflow/held-signals.ts";
import { runWorkflow } from "./run-workflow.ts";

afterEach(clearHeldSignals);

/** Waits on `approval` with a window, and reports which branch it took. */
const review = workflow({
  description: "review",
  run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
    const answer = await ctx.waitForSignal<{ ok?: boolean }>("approval", { timeoutMs: 60_000 });
    return { answered: answer !== undefined, answer };
  },
});

/** Sleeps AHEAD of its wait, so a signal sent at once lands before the wait is claimed. */
const slow = workflow({
  description: "slow",
  run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
    await ctx.sleep("warmup", 60_000);
    const answer = await ctx.waitForSignal<{ ok?: boolean }>("approval", { timeoutMs: 60_000 });
    return { answered: answer !== undefined, answer };
  },
});

describe("a signal with no payload", () => {
  test("delivers `{}`, so the body reads the ANSWERED branch as it does for a tool's bare signal", async () => {
    const run = await runWorkflow(review, {});
    await run.signalRun("approval");
    expect(run.signalled).toBe(true);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ answered: true, answer: {} });
  });

  test("wakes a `ctx.poll({ first })`, which reports `woken: true`", async () => {
    const polling = workflow({
      description: "polling",
      run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
        const polled = await ctx.poll("check", () => 1, {
          everyMs: 1000,
          maxMs: 0,
          done: () => true,
          first: { waitFor: ctx.signalToken("go"), timeoutMs: 60_000 },
        });
        return polled.woken;
      },
    });
    const run = await runWorkflow(polling, {}, { name: "polling" });
    await run.signal(`polling:${run.key}:go`);
    expect(run.signalled).toBe(true);
    expect(run.output).toBe(true);
  });
});

describe("a signal AHEAD of the wait", () => {
  test("signalRun holds it by default, and the wait takes it when the body gets there", async () => {
    const run = await runWorkflow(slow, {});
    expect(run.status).toBe("running");
    await run.signalRun("approval", { ok: true });
    // Taken, not delivered: the run is still parked on its sleep.
    expect(run.signalled).toBe(true);
    expect(run.status).toBe("running");
    await run.advanceSleep();
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ answered: true, answer: { ok: true } });
  });

  test("signalRun with `holdMs: 0` holds nothing, and the run parks on the wait", async () => {
    const run = await runWorkflow(slow, {});
    await run.signalRun("approval", { ok: true }, { holdMs: 0 });
    expect(run.signalled).toBe(false);
    await run.advanceSleep();
    expect(run.status).toBe("running");
    expect(run.waits.map((wait) => wait.kind)).toContain("hookTimeout");
  });

  test("signal holds only when asked, as `ctx.workflows.signal` does", async () => {
    const run = await runWorkflow(slow, {}, { name: "slow" });
    const token = `slow:${run.key}:approval`;
    await run.signal(token, { ok: true });
    expect(run.signalled).toBe(false);
    await run.signal(token, { ok: true }, { holdMs: 60_000 });
    expect(run.signalled).toBe(true);
    await run.advanceSleep();
    expect(run.output).toEqual({ answered: true, answer: { ok: true } });
  });

  test("signalRun after the run FINISHED holds nothing, so the next run under the key reads no stale answer", async () => {
    const run = await runWorkflow(review, {});
    await run.expireWaits();
    expect(run.status).toBe("completed");
    await run.signalRun("approval", { ok: true });
    expect(run.signalled).toBe(false);
    expect(heldSignalCount()).toBe(0);
    // Same name, key and label: the fresh run parks rather than completing on
    // the payload meant for the one before it.
    const next = await runWorkflow(review, {});
    expect(next.status).toBe("running");
  });

  test("a hold the run never took is dropped with the handle", async () => {
    const run = await runWorkflow(slow, {});
    await run.signalRun("approval", { ok: true });
    expect(heldSignalCount()).toBe(1);
    await run.close();
    expect(heldSignalCount()).toBe(0);
  });
});
