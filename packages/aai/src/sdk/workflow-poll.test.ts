// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.poll` over the `/testing` recorder: the checks are steps, the waits are
 * sleeps under the poll's own name, and the budget is a count of sleeps.
 */

import { describe, expect, test } from "vitest";
import { publishStepReporter } from "./step-report.ts";
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

  test("passes maxWaits to every check, so a check's dated Retry-After is a wait", async () => {
    const ctx = createWorkflowContext();
    await ctx.poll("check", () => 1, { everyMs: 5, maxMs: 5, done: () => false, maxWaits: 4 });
    expect(ctx.steps.map((s) => s.maxWaits)).toEqual([4, 4]);
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

describe("ctx.poll({ first })", () => {
  test("parks on the callback ONCE before the first check and reports it as woken", async () => {
    const ctx = createWorkflowContext({ hooks: { "job:1": { done: true } } });
    const polled = await ctx.poll("check", () => "ready", {
      first: { waitFor: "job:1", timeoutMs: 60_000 },
      everyMs: 10_000,
      maxMs: 60_000,
      done: (v) => v === "ready",
    });
    expect(polled).toEqual({ value: "ready", done: true, checks: 1, woken: true });
    // Journaled as the one `waitFor` the hand-written body made ahead of its
    // loop — the token is the wait's identity, exactly as `ctx.waitFor` keys it.
    expect(ctx.waited).toEqual(["job:1"]);
    expect(ctx.steps.map((s) => s.name)).toEqual(["check"]);
  });

  test("a callback that never comes is `woken: false`, and the checks begin anyway", async () => {
    const ctx = createWorkflowContext();
    const readings = ["pending", "ready"];
    let i = 0;
    const polled = await ctx.poll("check", () => readings[i++], {
      first: { waitFor: "job:2", timeoutMs: 1000 },
      everyMs: 10_000,
      maxMs: 60_000,
      done: (v) => v === "ready",
    });
    expect(polled).toEqual({ value: "ready", done: true, checks: 2, woken: false });
    expect(ctx.waited).toEqual(["job:2"]);
  });

  test("no token (no webhook URL was issued) means no park: the first check runs now, `woken: false`", async () => {
    const ctx = createWorkflowContext();
    const polled = await ctx.poll("check", () => "ready", {
      first: { waitFor: undefined, timeoutMs: 60_000 },
      everyMs: 10_000,
      maxMs: 60_000,
      done: (v) => v === "ready",
    });
    expect(polled).toEqual({ value: "ready", done: true, checks: 1, woken: false });
    expect(ctx.waited).toEqual([]);
  });

  test("the callback's payload is checked against `schema` and then discarded", async () => {
    const ctx = createWorkflowContext({ hooks: { "job:3": { ok: "yes" } } });
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "t",
        validate: () => ({ issues: [{ message: "nope" }] }),
      },
    };
    await expect(
      ctx.poll("check", () => 1, {
        first: { waitFor: "job:3", timeoutMs: 1000, schema },
        everyMs: 10,
        maxMs: 10,
        done: () => true,
      }),
    ).rejects.toThrow(/payload for hook job:3/);
  });

  test("a poll without `first` reports no `woken` at all", async () => {
    const ctx = createWorkflowContext();
    const polled = await ctx.poll("check", () => 1, { everyMs: 10, maxMs: 0, done: () => true });
    expect("woken" in polled).toBe(false);
  });
});

describe("ctx.poll({ slowAfterMs })", () => {
  test("writes the slow line ONCE, as its own step, after ceil(slowAfterMs / everyMs) sleeps", async () => {
    const ctx = createWorkflowContext();
    let n = 0;
    await ctx.poll("check", () => ++n, {
      everyMs: 10_000,
      maxMs: 50_000,
      slowAfterMs: 25_000,
      onSlow: "This is taking a while.",
      done: () => false,
    });
    // Three sleeps for 25s at 10s each; the report is journaled under the
    // poll's own name with a `:slow` suffix, so a replay answers it.
    const names = ctx.steps.map((s) => s.name);
    expect(names.filter((name) => name === "check:slow")).toHaveLength(1);
    expect(names.indexOf("check:slow")).toBe(3);
    expect(ctx.steps.find((s) => s.name === "check:slow")?.maxAttempts).toBe(1);
  });

  test("says nothing when the poll is done before the threshold", async () => {
    const ctx = createWorkflowContext();
    await ctx.poll("check", () => "ready", {
      everyMs: 10_000,
      maxMs: 50_000,
      slowAfterMs: 25_000,
      done: (v) => v === "ready",
    });
    expect(ctx.steps.map((s) => s.name)).toEqual(["check"]);
  });

  test("defaults the line to a sentence naming the poll, after the FIRST sleep at least", async () => {
    const lines: string[] = [];
    publishStepReporter(async (line) => {
      lines.push(String(line));
    });
    try {
      const ctx = createWorkflowContext();
      // `ceil(1 / 5)` is one sleep: a threshold shorter than an interval fires
      // after the first wait, never before any has been taken.
      await ctx.poll("check", () => 1, { everyMs: 5, maxMs: 5, slowAfterMs: 1, done: () => false });
      expect(ctx.steps.map((s) => s.name)).toEqual(["check", "check:slow", "check"]);
      expect(lines).toEqual(["Still waiting on check."]);
    } finally {
      publishStepReporter(undefined);
    }
  });

  test("an EMPTY onSlow is no line: the default sentence is written instead", async () => {
    const lines: string[] = [];
    publishStepReporter(async (line) => {
      lines.push(String(line));
    });
    try {
      const ctx = createWorkflowContext();
      await ctx.poll("check", () => 1, {
        everyMs: 5,
        maxMs: 5,
        slowAfterMs: 1,
        onSlow: "",
        done: () => false,
      });
      expect(lines).toEqual(["Still waiting on check."]);
    } finally {
      publishStepReporter(undefined);
    }
  });

  test("refuses an unusable slowAfterMs before checking anything", async () => {
    const ctx = createWorkflowContext();
    await expect(
      pollWorkflow(ctx, "check", () => 1, {
        everyMs: 10,
        maxMs: 10,
        slowAfterMs: Number.NaN,
        done: () => true,
      }),
    ).rejects.toThrow(/slowAfterMs/);
    expect(ctx.steps).toEqual([]);
  });
});
