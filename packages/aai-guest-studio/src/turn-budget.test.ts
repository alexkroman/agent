// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { closingNotice, HARD_TURN_MS, SOFT_TURN_MS, wrapUpNotice } from "./turn-budget.ts";
import { createTurnPolicy } from "./turn-continue.ts";

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

/** One step of a turn with no plan open, so only the deadlines can act. */
const plain = [{ role: "user" as const, content: "hi" }];
const step = (policy: ReturnType<typeof createTurnPolicy>) => policy.prepare(plain, plain);
const lastNotice = (s: ReturnType<typeof step>) => s.messages?.at(-1)?.content;

describe("the wall-clock turn budget", () => {
  test("says nothing and does not expire early in a turn", () => {
    const c = clock();
    const p = createTurnPolicy(c.now);
    c.advance(60_000);
    expect(step(p)).toEqual({});
    expect(p.expired()).toBe(false);
  });

  test("asks the agent to wrap up past the soft threshold", () => {
    const c = clock();
    const p = createTurnPolicy(c.now);
    c.advance(SOFT_TURN_MS);
    const s = step(p);
    expect(lastNotice(s)).toBe(wrapUpNotice(SOFT_TURN_MS));
    // The wrap-up asks for a spoken report, so it never sets `toolChoice`.
    expect(s.toolChoice).toBeUndefined();
  });

  test("the wrap-up notice ranks verified-partial first and demands honesty", () => {
    // A rushed agent claiming success is the failure this is meant to prevent,
    // not just a slow one.
    const notice = wrapUpNotice(SOFT_TURN_MS);
    expect(notice).toMatch(/verified partial/i);
    expect(notice).toMatch(/say so plainly/i);
    expect(notice).toContain("[5 minutes into this turn]");
  });

  test("warns once, not on every step", () => {
    // Repeating it would crowd the context it exists to protect.
    const c = clock();
    const p = createTurnPolicy(c.now);
    c.advance(SOFT_TURN_MS);
    expect(lastNotice(step(p))).toEqual(expect.any(String));
    c.advance(30_000);
    expect(step(p)).toEqual({});
  });

  test("spends one closing step at the hard bound, then expires", () => {
    // Never `expired` before the closing step is taken: stopping cold there
    // can end the turn on a tool call, leaving the user no text at all.
    const c = clock();
    const p = createTurnPolicy(c.now);
    c.advance(HARD_TURN_MS - 1);
    expect(step(p).toolChoice).toBeUndefined();
    expect(p.expired()).toBe(false);

    c.advance(1);
    expect(p.expired()).toBe(false);
    const closing = step(p);
    expect(closing.toolChoice).toBe("none");
    expect(lastNotice(closing)).toMatch(/cannot call any more tools/i);
    expect(lastNotice(closing)).toMatch(/still unfinished or broken/i);
    expect(p.expired()).toBe(true);
  });

  test("the closing step is offered once", () => {
    const c = clock();
    const p = createTurnPolicy(c.now);
    c.advance(HARD_TURN_MS);
    expect(lastNotice(step(p))).toBe(closingNotice(HARD_TURN_MS));
    c.advance(60_000);
    expect(step(p)).toEqual({});
    expect(p.expired()).toBe(true);
  });

  test("the hard bound clears the slowest run that actually succeeded", () => {
    // A 578s turn ended shippable; cutting that off would fail work that was
    // nearly done. The bound is for pathology, not for slow-but-working.
    expect(HARD_TURN_MS).toBeGreaterThan(578_000);
  });
});
