import { describe, expect, test } from "vitest";
import { createDefaultState, findUser, isError } from "./store.ts";
import { applySwap, assertCanCoverDiff, planItemSwap } from "./swap.ts";

function fixture(orderId: string) {
  const state = createDefaultState();
  const order = state.store.orders[orderId];
  if (!order) throw new Error(`fixture missing ${orderId}`);
  return { state, order };
}

describe("planItemSwap", () => {
  test("computes a positive price difference", () => {
    const { state, order } = fixture("#W9311069");
    const plan = planItemSwap(state, order, ["1304426904"], ["4725166838"], {
      requireDifferent: true,
    });
    if (isError(plan)) throw new Error(plan.error);
    expect(plan.diff).toBe(36.32);
    expect(plan.pairs).toHaveLength(1);
    expect(plan.pairs[0]?.newVariant.item_id).toBe("4725166838");
  });

  test("computes a negative price difference", () => {
    const { state, order } = fixture("#W5866402");
    const plan = planItemSwap(state, order, ["6242772310"], ["6200867091"], {
      requireDifferent: true,
    });
    expect(isError(plan) ? null : plan.diff).toBe(-40.86);
  });

  test("handles a duplicate item id swapped twice", () => {
    const { state, order } = fixture("#W4316152");
    const plan = planItemSwap(
      state,
      order,
      ["7292993796", "7292993796"],
      ["3909406921", "3909406921"],
      { requireDifferent: true },
    );
    if (isError(plan)) throw new Error(plan.error);
    expect(plan.diff).toBe(6.9);
    expect(plan.pairs.map((p) => p.index)).toEqual([0, 1]);
  });

  test("swapping one of two duplicates touches only one line", () => {
    const { state, order } = fixture("#W4316152");
    const plan = planItemSwap(state, order, ["7292993796"], ["3909406921"], {
      requireDifferent: true,
    });
    if (isError(plan)) throw new Error(plan.error);
    expect(plan.pairs).toHaveLength(1);
    expect(plan.diff).toBe(3.45);
  });

  test("refuses asking for more copies than the order holds", () => {
    const { state, order } = fixture("#W4316152");
    const plan = planItemSwap(
      state,
      order,
      ["7292993796", "7292993796", "7292993796"],
      ["3909406921", "3909406921", "3909406921"],
      { requireDifferent: true },
    );
    expect(isError(plan) && plan.error).toContain("7292993796");
  });

  test("refuses mismatched list lengths", () => {
    const { state, order } = fixture("#W4316152");
    const plan = planItemSwap(state, order, ["7292993796"], ["3909406921", "3738831434"], {
      requireDifferent: true,
    });
    expect(isError(plan) && plan.error.toLowerCase()).toContain("same number");
  });

  test("refuses an empty swap", () => {
    const { state, order } = fixture("#W4316152");
    expect(isError(planItemSwap(state, order, [], [], { requireDifferent: true }))).toBe(true);
  });

  test("refuses an item the order does not contain", () => {
    const { state, order } = fixture("#W4316152");
    const plan = planItemSwap(state, order, ["1304426904"], ["4725166838"], {
      requireDifferent: true,
    });
    expect(isError(plan)).toBe(true);
  });

  test("refuses a target of a different product", () => {
    const { state, order } = fixture("#W4316152");
    const plan = planItemSwap(state, order, ["7292993796"], ["4725166838"], {
      requireDifferent: true,
    });
    expect(isError(plan) && plan.error).toContain("Tea Kettle");
  });

  test("refuses an unavailable target", () => {
    const { state, order } = fixture("#W4316152");
    const plan = planItemSwap(state, order, ["7292993796"], ["6454334990"], {
      requireDifferent: true,
    });
    expect(isError(plan) && plan.error.toLowerCase()).toContain("not available");
  });

  test("requireDifferent refuses a no-op swap; exchange allows it", () => {
    const { state, order } = fixture("#W4316152");
    const strict = planItemSwap(state, order, ["7292993796"], ["7292993796"], {
      requireDifferent: true,
    });
    expect(isError(strict)).toBe(true);
    const loose = planItemSwap(state, order, ["7292993796"], ["7292993796"], {
      requireDifferent: false,
    });
    expect(isError(loose) ? null : loose.diff).toBe(0);
  });
});

describe("assertCanCoverDiff", () => {
  function aarav() {
    const state = createDefaultState();
    const user = findUser(state, "aarav_anderson_8794");
    if (isError(user)) throw new Error(user.error);
    return user;
  }

  test("refuses a gift card that cannot cover the difference", () => {
    const result = assertCanCoverDiff(aarav(), "gift_card_7245904", 36.32);
    expect(result?.error.toLowerCase()).toContain("balance");
    expect(result?.error).toContain("17");
  });

  test("allows a difference the gift card covers", () => {
    expect(assertCanCoverDiff(aarav(), "gift_card_7245904", 3.45)).toBeNull();
  });

  test("allows a refund direction regardless of balance", () => {
    expect(assertCanCoverDiff(aarav(), "gift_card_7245904", -382.03)).toBeNull();
  });

  test("does not gate a non-gift-card method on any balance", () => {
    const state = createDefaultState();
    const olivia = findUser(state, "olivia_ito_3591");
    if (isError(olivia)) throw new Error(olivia.error);
    expect(assertCanCoverDiff(olivia, "credit_card_9753331", 100_000)).toBeNull();
  });

  test("refuses a method not on the profile", () => {
    expect(assertCanCoverDiff(aarav(), "gift_card_7794233", 1)?.error).toContain("profile");
  });
});

describe("applySwap", () => {
  test("each swapped line takes its OWN new price and options", () => {
    const { state, order } = fixture("#W9311069");
    // Two different products in one call — this is what catches the leaked
    // loop variable tau2's implementation writes prices with.
    const plan = planItemSwap(
      state,
      order,
      ["1304426904", "4238115171"],
      ["4725166838", "3909406921"],
      { requireDifferent: true },
    );
    if (isError(plan)) throw new Error(plan.error);
    applySwap(order, plan);

    const vacuum = order.items.find((i) => i.item_id === "4725166838");
    const kettle = order.items.find((i) => i.item_id === "3909406921");
    expect(vacuum?.price).toBe(602.11);
    expect(kettle?.price).toBe(98.25);
    expect(vacuum?.name).toBe("Vacuum Cleaner");
    expect(kettle?.options).toEqual(
      state.store.products["9832717871"]?.variants["3909406921"]?.options,
    );
  });

  test("leaves untouched lines alone", () => {
    const { state, order } = fixture("#W4316152");
    const plan = planItemSwap(state, order, ["7292993796"], ["3909406921"], {
      requireDifferent: true,
    });
    if (isError(plan)) throw new Error(plan.error);
    applySwap(order, plan);
    expect(order.items.map((i) => i.item_id)).toEqual(["3909406921", "7292993796"]);
  });
});
