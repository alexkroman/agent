// Copyright 2026 the AAI authors. MIT license.
/**
 * A slot's projection to the browser — the `syncState` half of `sessionSlot`.
 *
 * Split out of `session-slot.test.ts` when that file crossed the 700-line cap,
 * along the seam the two groups below already draw: everything here is about ONE
 * function of a value, so none of it needs that suite's storability table, its
 * open-draft guard or its tool builders. What it does need is a slot and a
 * context, which is three lines.
 *
 * The two groups are the two spellings, and the second is the point:
 * `slot.projection(view)` composes a projection per call, so the agent and the
 * page each compose their own and nothing relates them; `slot.projected` is the
 * slot's DECLARED view, built once, so both ends pass the same object.
 */

import { describe, expect, test } from "vitest";
import { type DeepReadonly, sessionSlot } from "./session-slot.ts";
import { createToolContext } from "./testing.ts";

type Cart = { items: string[]; nextId: number };

const emptyCart = (): Cart => ({ items: [], nextId: 1 });
const cartSlot = sessionSlot("cart", emptyCart);

describe("projection", () => {
  const view = (cart: DeepReadonly<Cart>) => ({ count: cart.items.length });

  test("projects the stored value", () => {
    expect(cartSlot.projection(view)({ items: ["a", "b"], nextId: 3 })).toEqual({ count: 2 });
  });

  test("projects the default before anything is stored", () => {
    // What makes a client's empty-state fallback derivable from the projection
    // itself rather than hand-written — five templates hoist exactly this.
    expect(cartSlot.projection(view)()).toEqual({ count: 0 });
    expect(cartSlot.projection(view)(undefined)).toEqual({ count: 0 });
  });

  test("the projection sees a non-optional value", () => {
    // The callback's parameter is a real `Cart`, so a projection needs no
    // optional chaining. A type-level claim, asserted by dereferencing.
    expect(cartSlot.projection((cart) => cart.items.length)(undefined)).toBe(0);
  });

  test("carries the slot's key and default, which is what the runtime reads", () => {
    const projection = cartSlot.projection(view);
    expect(projection.key).toBe("cart");
    expect(projection.create()).toEqual({ items: [], nextId: 1 });
  });

  test("its default is minted per call, never a shared object", () => {
    const projection = cartSlot.projection(view);
    expect(projection.create()).not.toBe(projection.create());
  });

  test("two compositions of the same view are DIFFERENT objects", () => {
    // The hazard `projected` exists to remove, stated as the fact that makes
    // it one: composing at each end produces two projections, so nothing
    // relates the frame the agent pushes to the frame the page renders — and
    // `useAgentState` memoizes on identity, so an inline composition is also
    // a fresh empty frame per render.
    expect(cartSlot.projection(view)).not.toBe(cartSlot.projection(view));
  });
});

describe("projected", () => {
  const viewedSlot = sessionSlot("viewed", emptyCart, {
    view: (cart) => ({ count: cart.items.length }),
  });

  test("is the slot's declared view, built once", () => {
    // Identity-stable across accesses, which is what makes passing it at both
    // ends the same object rather than two equal expressions — and what
    // `useAgentState`'s empty-frame memo is keyed on.
    expect(viewedSlot.projected).toBe(viewedSlot.projected);
    expect(viewedSlot.projected({ items: ["a"], nextId: 2 })).toEqual({ count: 1 });
    // The view's own return type IS the projection's, so neither end restates
    // it — an annotation is what checks that claim, and this suite is
    // type-checked (`Type Errors` in the run output).
    const frame: { count: number } = viewedSlot.projected();
    expect(frame.count).toBe(0);
  });

  test("the two ends agree on the frame's SHAPE, before and after the first push", () => {
    // THE drift this fix eliminates. The browser renders `projected()` before
    // any tool has run; the runtime pushes `projected(stored)` after. With one
    // declaration those are one function, so the keys cannot differ — where a
    // view composed separately at each end could name different fields with
    // nothing checking.
    const ctx = createToolContext();
    const beforeFirstPush = viewedSlot.projected();
    viewedSlot.update(ctx, (cart) => cart.items.push("apple"));
    const pushed = viewedSlot.projected(ctx.slots.read("viewed"));

    expect(Object.keys(pushed).sort()).toEqual(Object.keys(beforeFirstPush).sort());
    // And the same view, not merely the same keys: the count really moved.
    expect(beforeFirstPush).toEqual({ count: 0 });
    expect(pushed).toEqual({ count: 1 });
  });

  test("carries the slot's key and default, like any projection", () => {
    expect(viewedSlot.projected.key).toBe("viewed");
    expect(viewedSlot.projected.create()).toEqual({ items: [], nextId: 1 });
  });

  test("projects the WHOLE value when no view is declared", () => {
    // Total rather than conditionally present, so "no view" has to mean
    // something — and this is what `slot.projection((v) => v)` already meant.
    expect(cartSlot.projected({ items: ["a", "b"], nextId: 3 })).toEqual({
      items: ["a", "b"],
      nextId: 3,
    });
    expect(cartSlot.projected()).toEqual({ items: [], nextId: 1 });
  });

  test("holds the slot's caps on the pre-push frame too", () => {
    // Same rule `projection` follows: a stored value never exceeds its caps,
    // so neither may the frame rendered before the first tool call.
    const capped = sessionSlot("capped-view", (): { log: string[] } => ({ log: ["a", "b", "c"] }), {
      caps: { log: 2 },
      view: (value) => ({ log: value.log }),
    });
    expect(capped.projected()).toEqual({ log: ["b", "c"] });
  });
});
