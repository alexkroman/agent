// Copyright 2026 the AAI authors. MIT license.
/**
 * The recorder's own spec.
 *
 * It is test infrastructure, so what matters is that it cannot LIE: a spec built
 * on it asserts what the body asked for, and a recorder that dropped an option
 * or ran a step it was told not to would make every such assertion vacuous.
 */

import { describe, expect, test, vi } from "vitest";
import { createWorkflowCtx } from "./testing-workflow-ctx.ts";
import type { WorkflowCtx } from "./workflow-ctx.ts";

/** A body exercising all three ctx methods, as a real `workflows/` module would. */
async function body(input: { topic: string }, ctx: WorkflowCtx): Promise<unknown> {
  const notes = await ctx.step("research", () => `notes on ${input.topic}`, { maxAttempts: 6 });
  await ctx.sleep(10_000, { correlationId: "settle" });
  const approved = await ctx.waitFor<{ ok: boolean }>("tok_gate", { timeoutMs: 5000 });
  const filed = await ctx.step("file", () => "filed");
  return { notes, approved, filed };
}

describe("steps", () => {
  test("runs them by default and returns what they returned", async () => {
    const work = vi.fn(() => "done");
    const ctx = createWorkflowCtx();
    await expect(ctx.step("research", work)).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
  });

  test("records the name and the attempts the body asked for", async () => {
    const ctx = createWorkflowCtx({ hooks: { tok_gate: { ok: true } } });
    await body({ topic: "otters" }, ctx);
    expect(ctx.steps).toEqual([
      { name: "research", maxAttempts: 6 },
      // No options passed, so no budget claimed — which is the other half of an
      // assertion that one step's budget was RAISED.
      { name: "file", maxAttempts: undefined },
    ]);
  });

  test("records without running under `runSteps: false`", async () => {
    const work = vi.fn(() => "done");
    const ctx = createWorkflowCtx({ runSteps: false });
    await expect(ctx.step("research", work)).resolves.toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    expect(ctx.steps).toEqual([{ name: "research", maxAttempts: undefined }]);
  });

  test("a supplied result wins over running, so one expensive step can be stubbed", async () => {
    const work = vi.fn(() => "the real thing");
    const ctx = createWorkflowCtx({ results: { research: "stubbed" } });
    await expect(ctx.step("research", work)).resolves.toBe("stubbed");
    expect(work).not.toHaveBeenCalled();
  });

  test("a supplied result answers under `runSteps: false` too", async () => {
    // This is what makes a body whose control flow READS its steps drivable at
    // all: without it `planAngles` resolves `undefined` and the fan-out below it
    // gets a missing list.
    const ctx = createWorkflowCtx({ runSteps: false, results: { plan: ["a", "b"] } });
    await expect(ctx.step("plan", () => [])).resolves.toEqual(["a", "b"]);
  });

  test("records a step reached twice as two entries", async () => {
    // A loop is one call site and N journal entries under the real engine, so a
    // recorder that de-duplicated by name would hide the iterations.
    const ctx = createWorkflowCtx();
    await ctx.step("tick", () => 1);
    await ctx.step("tick", () => 2);
    expect(ctx.steps).toHaveLength(2);
  });
});

describe("sleeps", () => {
  test("are RECORDED rather than taken, so a schedule is assertable in milliseconds", async () => {
    const before = Date.now();
    const ctx = createWorkflowCtx();
    await ctx.sleep(6 * 60 * 60 * 1000);
    // Not waited out — the whole reason a case can assert a six-hour schedule.
    expect(Date.now() - before).toBeLessThan(1000);
    expect(ctx.slept).toEqual([{ until: 21_600_000, correlationId: undefined }]);
  });

  test("carry the correlation id the body named", async () => {
    const ctx = createWorkflowCtx();
    await ctx.sleep(10_000, { correlationId: "settle" });
    expect(ctx.slept[0]?.correlationId).toBe("settle");
  });

  test("keep an absolute Date as given", async () => {
    const at = new Date("2030-01-01T00:00:00.000Z");
    const ctx = createWorkflowCtx();
    await ctx.sleep(at);
    expect(ctx.slept[0]?.until).toEqual(at);
  });
});

describe("hooks", () => {
  test("answer from `hooks`, by token", async () => {
    const ctx = createWorkflowCtx({ hooks: { tok_gate: { ok: true } } });
    await expect(ctx.waitFor("tok_gate")).resolves.toEqual({ ok: true });
    expect(ctx.waited).toEqual(["tok_gate"]);
  });

  test("a wait WITH a deadline and no payload resolves undefined", async () => {
    // The closed-window branch, which is what a retention gate's safe default
    // is — reached by simply not supplying an answer.
    const ctx = createWorkflowCtx();
    await expect(ctx.waitFor("tok_gate", { timeoutMs: 1000 })).resolves.toBeUndefined();
  });

  test("a wait with NO deadline and no payload throws, naming what to pass", async () => {
    // Rather than hanging: a spec that hangs reports a runner timeout instead of
    // the missing payload.
    const ctx = createWorkflowCtx();
    await expect(ctx.waitFor("tok_gate")).rejects.toThrow(/no payload for hook "tok_gate"/);
  });
});

describe("identity", () => {
  test("defaults the run id and workflow, and takes overrides", () => {
    expect(createWorkflowCtx()).toMatchObject({ runId: "wrun_test", workflow: "test" });
    expect(createWorkflowCtx({ runId: "wrun_9", workflow: "digest" })).toMatchObject({
      runId: "wrun_9",
      workflow: "digest",
    });
  });
});
