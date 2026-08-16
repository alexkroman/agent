// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createTurnBudget, HARD_TURN_MS, SOFT_TURN_MS } from "./studio-turn-budget.ts";

/** A controllable clock — the budget must not depend on real time in tests. */
function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createTurnBudget", () => {
  test("says nothing and does not expire early in a turn", () => {
    const c = clock();
    const b = createTurnBudget(c.now);
    c.advance(60_000);
    expect(b.takeWrapUpNotice()).toBeNull();
    expect(b.expired()).toBe(false);
  });

  test("asks the agent to wrap up past the soft threshold", () => {
    const c = clock();
    const b = createTurnBudget(c.now);
    c.advance(SOFT_TURN_MS);
    const notice = b.takeWrapUpNotice();
    // `toBeDefined()` was the assertion here, and `null` is defined — the
    // return type is `string | null`, so it held for a budget that never
    // offered a notice at all.
    expect(notice).toEqual(expect.any(String));
    // It must rank verified-partial above unverified-complete, and require
    // an honest report — a rushed agent claiming success is the failure
    // this is meant to prevent, not just a slow one.
    expect(notice).toMatch(/verified partial/i);
    expect(notice).toMatch(/say so plainly/i);
  });

  test("warns once, not on every step", () => {
    // Repeating it would crowd the context it exists to protect.
    const c = clock();
    const b = createTurnBudget(c.now);
    c.advance(SOFT_TURN_MS);
    expect(b.takeWrapUpNotice()).toEqual(expect.any(String));
    c.advance(30_000);
    expect(b.takeWrapUpNotice()).toBeNull();
  });

  test("spends one closing step at the hard bound, then expires", () => {
    // Never `expired` before the closing step is taken: stopping cold there
    // can end the turn on a tool call, leaving the user no text at all.
    const c = clock();
    const b = createTurnBudget(c.now);
    c.advance(HARD_TURN_MS - 1);
    expect(b.takeFinalNotice()).toBeNull();
    expect(b.expired()).toBe(false);

    c.advance(1);
    expect(b.expired()).toBe(false);
    const closing = b.takeFinalNotice();
    expect(closing).toMatch(/cannot call any more tools/i);
    expect(closing).toMatch(/still unfinished or broken/i);
    expect(b.expired()).toBe(true);
  });

  test("the closing step is offered once", () => {
    const c = clock();
    const b = createTurnBudget(c.now);
    c.advance(HARD_TURN_MS);
    // Same trap as the wrap-up notice above: the whole point of this test is
    // that a closing step WAS offered before `expired()` latches, and
    // `toBeDefined()` is satisfied by the `null` that means it was not.
    expect(b.takeFinalNotice()).toEqual(expect.any(String));
    c.advance(60_000);
    expect(b.takeFinalNotice()).toBeNull();
    expect(b.expired()).toBe(true);
  });

  test("the hard bound clears the slowest run that actually succeeded", () => {
    // A 578s turn ended shippable; cutting that off would fail work that was
    // nearly done. The bound is for pathology, not for slow-but-working.
    expect(HARD_TURN_MS).toBeGreaterThan(578_000);
  });
});
