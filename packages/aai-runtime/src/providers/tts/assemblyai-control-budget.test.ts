// Copyright 2026 the AAI authors. MIT license.
// The control-frame token bucket on its own, on an injected clock.

import { describe, expect, test } from "vitest";
import {
  CONTROL_FRAME_BURST,
  CONTROL_FRAME_RESERVE,
  CONTROL_FRAMES_PER_SECOND,
  createControlBudget,
} from "./assemblyai-control-budget.ts";

const DOCUMENTED_SUSTAINED_PER_SECOND = 20;

function clock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Take until refused; how many were taken. */
function drain(budget: ReturnType<typeof createControlBudget>, floor: number): number {
  let taken = 0;
  while (budget.tryTake(floor)) taken += 1;
  return taken;
}

describe("createControlBudget", () => {
  test("a full bucket plus one second of refill stays within the documented sustained rate", () => {
    // The guarantee the adapter relies on: no one-second window can exceed 20.
    expect(CONTROL_FRAME_BURST + CONTROL_FRAMES_PER_SECOND).toBeLessThanOrEqual(
      DOCUMENTED_SUSTAINED_PER_SECOND,
    );
    expect(CONTROL_FRAME_RESERVE).toBeLessThan(CONTROL_FRAME_BURST);
  });

  test("tryTake spends down to the floor and no further", () => {
    const c = clock();
    const budget = createControlBudget({ burst: 10, perSecond: 10, now: c.now });
    expect(drain(budget, 4)).toBe(6);
    // The reserve is still there for a floor-0 caller.
    expect(drain(budget, 0)).toBe(4);
  });

  test("refills at the configured rate, capped at the burst", () => {
    const c = clock();
    const budget = createControlBudget({ burst: 10, perSecond: 10, now: c.now });
    drain(budget, 0);
    expect(budget.msUntil(0)).toBe(100);
    c.advance(99);
    expect(budget.tryTake(0)).toBe(false);
    c.advance(1);
    expect(budget.tryTake(0)).toBe(true);
    c.advance(60_000);
    expect(drain(budget, 0)).toBe(10);
  });

  test("a clock that steps backwards refills nothing rather than draining", () => {
    let t = 1000;
    const budget = createControlBudget({ burst: 10, perSecond: 10, now: () => t });
    t = 0;
    expect(drain(budget, 0)).toBe(10);
  });

  test("take overdraws, and the overdraft is repaid before a flush can spend", () => {
    const c = clock();
    const budget = createControlBudget({ burst: 2, perSecond: 10, now: c.now });
    budget.take();
    budget.take();
    budget.take(); // -1
    expect(budget.tryTake(0)).toBe(false);
    expect(budget.msUntil(0)).toBe(200);
  });
});
