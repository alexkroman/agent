// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.poll` through the real replay engine: each wait SUSPENDS the run, a
 * redelivery resumes it where it left off, and the journal holds the same keys
 * a hand-written check-and-sleep loop would.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { harness } from "./_engine-harness.ts";

describe("ctx.poll", () => {
  test("suspends between checks and resolves once done, across deliveries", async () => {
    // Each wait is a deadline on the clock, so the clock is moved past it.
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let checks = 0;
    const { engine, journal } = harness({
      call: async (_input, ctx: WorkflowContext) => {
        const polled = await ctx.poll("check", () => ++checks, {
          everyMs: 20,
          maxMs: 1000,
          done: (n) => n >= 3,
        });
        return polled;
      },
    });
    const runId = await engine.start("call", [{}]);
    const statuses: (string | undefined)[] = [];
    for (let delivery = 0; delivery < 10; delivery++) {
      const status = await engine.execute(runId);
      statuses.push(status);
      if (status === "completed") break;
      vi.advanceTimersByTime(30);
    }
    expect(statuses.at(-1)).toBe("completed");
    // Every wait was a real suspension, so the run took one delivery per check.
    expect(statuses.filter((s) => s === "running")).toHaveLength(2);
    // Each check ran once: a replay answered the earlier ones from the journal.
    expect(checks).toBe(3);
    expect((await engine.getRun(runId))?.output).toEqual({ value: 3, done: true, checks: 3 });
    const keys = (await journal.readSteps(runId))
      .map((s) => s.key)
      .sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual(["check#0", "check#1", "check#2"]);
  });
});
