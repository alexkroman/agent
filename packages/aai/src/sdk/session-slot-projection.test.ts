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
 * `slot.projected` is the slot's DECLARED view, built once, so the agent and
 * the page pass the same object.
 */

import { describe, expect, test } from "vitest";
import { agent } from "./define.ts";
import { sessionSlot } from "./session-slot.ts";
import { createToolContext } from "./testing.ts";

type Cart = { items: string[]; nextId: number };

const emptyCart = (): Cart => ({ items: [], nextId: 1 });
const cartSlot = sessionSlot("cart", emptyCart);

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

  test("its default is minted per call, never a shared object", () => {
    expect(viewedSlot.projected.create()).not.toBe(viewedSlot.projected.create());
  });

  test("projects the WHOLE value when no view is declared", () => {
    // Total rather than conditionally present, so "no view" has to mean
    // something.
    expect(cartSlot.projected({ items: ["a", "b"], nextId: 3 })).toEqual({
      items: ["a", "b"],
      nextId: 3,
    });
    expect(cartSlot.projected()).toEqual({ items: [], nextId: 1 });
  });

  test("holds the slot's caps on the pre-push frame too", () => {
    // A stored value never exceeds its caps, so neither may the frame rendered
    // before the first tool call.
    const capped = sessionSlot("capped-view", (): { log: string[] } => ({ log: ["a", "b", "c"] }), {
      caps: { log: 2 },
      view: (value) => ({ log: value.log }),
    });
    expect(capped.projected()).toEqual({ log: ["b", "c"] });
  });
});

describe("agent({ syncState }) takes projections and keys them by slot name", () => {
  /** Past the overloads on purpose — the run-time half an untyped config meets. */
  const untyped = (syncState: unknown) =>
    agent({ name: "Shop", syncState } as Parameters<typeof agent>[0]);
  const prefsSlot = sessionSlot("prefs", () => ({ units: "metric" }));

  test("one projection resolves to one entry under its slot's name", () => {
    const def = agent({ name: "Shop", syncState: cartSlot.projected });
    expect(def.syncState).toEqual({ cart: cartSlot.projected });
  });

  test("a list resolves to one entry per slot, in order", () => {
    const def = agent({ name: "Shop", syncState: [cartSlot.projected, prefsSlot.projected] });
    expect(Object.keys(def.syncState ?? {})).toEqual(["cart", "prefs"]);
    expect(def.syncState?.prefs).toBe(prefsSlot.projected);
  });

  test("a record key that disagrees with its slot is refused, naming the slot", () => {
    expect(() => untyped({ basket: cartSlot.projected })).toThrow(
      /`syncState.basket` projects the "cart" slot — pass the projection itself/,
    );
  });

  test("two projections of one slot are refused", () => {
    expect(() => untyped([cartSlot.projected, cartSlot.projected])).toThrow(
      /projects the "cart" slot twice/,
    );
  });

  test("an entry that is not a projection is refused with the spelling to write", () => {
    expect(() => untyped({ cart: { items: [] } })).toThrow(
      /`syncState.cart` is not a slot projection — write `syncState: cartSlot.projected`/,
    );
    expect(() => untyped([{ items: [] }])).toThrow(/`syncState\[0\]` is not a slot projection/);
    expect(() => untyped("cart")).toThrow(/takes a slot projection or a list of them/);
  });

  test("normalizing is idempotent, as toAgentConfig re-normalizes agent()'s output", () => {
    const def = agent({ name: "Shop", syncState: [cartSlot.projected] });
    expect(untyped(def.syncState).syncState).toEqual(def.syncState);
  });
});
