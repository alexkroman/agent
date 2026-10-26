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
import { rawConfig } from "./_test-utils.ts";
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

describe("syncState is collected, never authored", () => {
  /** Past the overloads on purpose — the run-time half an untyped config meets. */
  const untyped = (syncState: unknown) =>
    agent({ name: "Shop", syncState } as Parameters<typeof agent>[0]);
  /** The config boundary, which a raw `export default {...}` reaches without `agent()`. */
  const raw = (syncState: unknown) => rawConfig({ name: "Shop", syncState });

  test("agent() refuses the key, naming the slot option that replaces it", () => {
    expect(() => untyped(cartSlot.projected)).toThrow(
      /sessionSlot\(key, create, \{ view, sync: true \}\)/,
    );
    expect(() => untyped([cartSlot.projected])).toThrow(
      /agent\(\{ syncState \}\) is not how a slot reaches the browser/,
    );
  });

  test("a sync: true slot reaches the def keyed by its own name", () => {
    const synced = sessionSlot("synced-shop", () => ({ items: 0 }), {
      view: (c) => c,
      sync: true,
    });
    expect(agent({ name: "Shop" }).syncState).toEqual({ "synced-shop": synced.projected });
  });

  test("the config boundary keeps a collected record and refuses the authored forms", () => {
    // A lowered def's record crosses `toAgentConfig` (host-only, stripped from
    // the wire) — and one built by another SDK copy is validated and kept.
    expect(() => raw({ cart: cartSlot.projected })).not.toThrow();
    expect(() => raw(cartSlot.projected)).toThrow(/`syncState` is not authored/);
    expect(() => raw([cartSlot.projected])).toThrow(/`syncState` is not authored/);
    // A record key that disagrees with its slot would publish one name and
    // render another.
    expect(() => raw({ basket: cartSlot.projected })).toThrow(
      /`syncState.basket` is not that slot's own projection/,
    );
    expect(() => raw({ cart: { items: [] } })).toThrow(
      /`syncState.cart` is not that slot's own projection/,
    );
  });
});

describe("the pre-push frame", () => {
  test("runs the slot's after hook, so it matches the stored shape", () => {
    const derived = sessionSlot(
      "derived",
      (): { items: string[]; count: number } => ({ items: [], count: -1 }),
      {
        after: (value) => {
          value.count = value.items.length;
        },
      },
    );
    expect(derived.projected()).toEqual({ items: [], count: 0 });
  });

  test("projects `empty()` instead of the seeded default, hooked and capped alike", () => {
    const seeded = sessionSlot(
      "seeded",
      (): { catalogue: string[]; count: number } => ({ catalogue: ["a", "b", "c"], count: -1 }),
      {
        empty: () => ({ catalogue: [], count: -1 }),
        caps: { catalogue: 2 },
        after: (value) => {
          value.count = value.catalogue.length;
        },
      },
    );
    expect(seeded.projected()).toEqual({ catalogue: [], count: 0 });
    // The seed is still what a session installs, and a stored value projects as is.
    expect(seeded.get(createToolContext())).toEqual({ catalogue: ["b", "c"], count: 3 });
    expect(seeded.projected({ catalogue: ["z"], count: 1 })).toEqual({
      catalogue: ["z"],
      count: 1,
    });
  });
});
