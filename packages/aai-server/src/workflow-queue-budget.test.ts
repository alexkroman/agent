// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createDeliveryBudget } from "./workflow-queue-budget.ts";

describe("createDeliveryBudget", () => {
  test("answers what is free, never more than the limit, without waiting", async () => {
    const budget = createDeliveryBudget(3);
    expect(await budget.take(2)).toHaveLength(2);
    // One slot left: a request for five gets one rather than parking.
    expect(await budget.take(5)).toHaveLength(1);
    expect(await budget.take(1)).toEqual([]);
  });

  test("the budget is shared ACROSS takes, and a release gives one slot back", async () => {
    const budget = createDeliveryBudget(2);
    const [first, second] = await budget.take(2);
    first?.();
    expect(await budget.take(2)).toHaveLength(1);
    second?.();
    expect(await budget.take(2)).toHaveLength(1);
  });

  test("a release is idempotent, so a finally and a catch-all cannot double-free", async () => {
    const budget = createDeliveryBudget(1);
    const [slot] = await budget.take(1);
    slot?.();
    slot?.();
    expect(await budget.take(3)).toHaveLength(1);
  });

  test("a limit under one still leaves one slot, so delivery cannot wedge", async () => {
    expect(await createDeliveryBudget(0).take(2)).toHaveLength(1);
    expect(await createDeliveryBudget(2.6).take(5)).toHaveLength(3);
  });

  test("asking for none takes none", async () => {
    expect(await createDeliveryBudget(4).take(0)).toEqual([]);
  });
});
