// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.poll` over the `/testing` recorder: the checks are steps, the waits are
 * sleeps under the poll's own name, and the budget is a count of sleeps.
 */

import { describe, expect, test } from "vitest";
import { createWorkflowContext } from "./testing-workflow-ctx.ts";
import { pollWorkflow } from "./workflow-poll.ts";

describe("ctx.poll", () => {
  test("checks, sleeps everyMs, and resolves the value that is done", async () => {
    const ctx = createWorkflowContext();
    const readings = ["queued", "ringing", "completed"];
    let i = 0;
    const polled = await ctx.poll("check", () => readings[i++], {
      everyMs: 10_000,
      maxMs: 60_000,
      done: (status) => status === "completed",
    });
    expect(polled).toEqual({ value: "completed", done: true, checks: 3 });
    expect(ctx.steps.map((s) => s.name)).toEqual(["check", "check", "check"]);
    expect(ctx.slept.map((s) => [s.label, s.until])).toEqual([
      ["check", 10_000],
      ["check", 10_000],
    ]);
  });

  test("gives up after floor(maxMs / everyMs) sleeps with the latest reading", async () => {
    const ctx = createWorkflowContext();
    let n = 0;
    const polled = await ctx.poll("check", () => ++n, {
      everyMs: 10_000,
      maxMs: 35_000,
      done: () => false,
    });
    expect(polled).toEqual({ value: 4, done: false, checks: 4 });
    expect(ctx.slept).toHaveLength(3);
  });

  test("a zero budget is exactly one check", async () => {
    const ctx = createWorkflowContext();
    const polled = await ctx.poll("once", () => "x", {
      everyMs: 1000,
      maxMs: 0,
      done: () => false,
    });
    expect(polled).toEqual({ value: "x", done: false, checks: 1 });
    expect(ctx.slept).toEqual([]);
  });

  test("passes maxAttempts to every check", async () => {
    const ctx = createWorkflowContext();
    await ctx.poll("check", () => 1, { everyMs: 5, maxMs: 5, done: () => false, maxAttempts: 7 });
    expect(ctx.steps.map((s) => s.maxAttempts)).toEqual([7, 7]);
  });

  test("a `results` entry answers every check, as it does for a hand-written loop", async () => {
    const ctx = createWorkflowContext({ results: { check: "done" } });
    const polled = await ctx.poll("check", () => "never run", {
      everyMs: 5,
      maxMs: 50,
      done: (v) => v === "done",
    });
    expect(polled).toEqual({ value: "done", done: true, checks: 1 });
  });

  test.each([
    [{ everyMs: 0, maxMs: 10 }, /everyMs/],
    [{ everyMs: Number.NaN, maxMs: 10 }, /everyMs/],
    [{ everyMs: 10, maxMs: -1 }, /maxMs/],
    [{ everyMs: 10, maxMs: Number.POSITIVE_INFINITY }, /maxMs/],
  ])("refuses an unusable budget %j before checking anything", async (budget, message) => {
    const ctx = createWorkflowContext();
    await expect(
      pollWorkflow(ctx, "check", () => 1, { ...budget, done: () => true }),
    ).rejects.toThrow(message);
    expect(ctx.steps).toEqual([]);
  });
});
