// Copyright 2026 the AAI authors. MIT license.
// The host-side token meter: what it counts, what it refuses to invent, and
// when a budget stops a session.

import { describe, expect, test } from "vitest";
import { makeUsageMeter } from "./_test-utils.ts";

describe("createUsageMeter", () => {
  test("accumulates across steps and announces the running total", () => {
    const { meter, updates } = makeUsageMeter();
    meter.record({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    meter.record({ inputTokens: 300, outputTokens: 40, totalTokens: 340 });
    expect(meter.snapshot()).toEqual({
      inputTokens: 400,
      outputTokens: 60,
      totalTokens: 460,
      steps: 2,
    });
    // CUMULATIVE at every announcement — a reader that joined late still sees
    // the true total, which is the whole reason the event carries a sum.
    expect(updates.map((u) => u.totalTokens)).toEqual([120, 460]);
  });

  test("believes a reported total that is not the sum of its parts", () => {
    // A provider that bills a reasoning or cache line item reports a total
    // larger than input + output. Recomputing would under-report the bill.
    const { meter } = makeUsageMeter();
    meter.record({ inputTokens: 10, outputTokens: 5, totalTokens: 40 });
    expect(meter.snapshot().totalTokens).toBe(40);
  });

  test("falls back to the sum when only the two halves are reported", () => {
    const { meter } = makeUsageMeter();
    meter.record({ inputTokens: 10, outputTokens: 5 });
    expect(meter.snapshot().totalTokens).toBe(15);
  });

  test("a step that reports nothing still counts as a step", () => {
    // The signature of a provider that meters nothing: `steps` climbs while the
    // total does not. That is worth being able to SEE, which is why an
    // unreported step is announced rather than skipped.
    const { meter, updates } = makeUsageMeter();
    meter.record(undefined);
    meter.record({ inputTokens: Number.NaN, outputTokens: -3 });
    expect(meter.snapshot()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      steps: 2,
    });
    expect(updates).toHaveLength(2);
  });

  test("no limit is never exhausted", () => {
    const { meter } = makeUsageMeter();
    meter.record({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(meter.exhausted()).toBeUndefined();
  });

  test("a limit is reached at or past the cap, and the reason names both numbers", () => {
    const { meter } = makeUsageMeter({ totalTokens: 500 });
    meter.record({ inputTokens: 400, outputTokens: 50 });
    expect(meter.exhausted()).toBeUndefined();
    meter.record({ inputTokens: 40, outputTokens: 20 });
    const reason = meter.exhausted();
    expect(reason).toContain("510");
    expect(reason).toContain("500");
    expect(reason).toContain("usageLimits.totalTokens");
  });

  test("the snapshot is a COPY, so a reader cannot move the meter", () => {
    const { meter, updates } = makeUsageMeter();
    meter.record({ inputTokens: 5, outputTokens: 5 });
    const snapshot = meter.snapshot();
    snapshot.totalTokens = 0;
    expect(meter.snapshot().totalTokens).toBe(10);
    // And the announced value is a copy too — an event body handed to a client
    // must not keep mutating after it is sent.
    expect(updates[0]?.totalTokens).toBe(10);
  });
});
