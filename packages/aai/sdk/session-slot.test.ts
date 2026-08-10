// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { sessionSlot } from "./session-slot.ts";
import { createToolContext } from "./testing.ts";

type Cart = { items: string[]; nextId: number };

const emptyCart = (): Cart => ({ items: [], nextId: 1 });
const cartSlot = sessionSlot("cart", emptyCart);

describe("sessionSlot", () => {
  test("exposes the key it occupies", () => {
    expect(cartSlot.key).toBe("cart");
  });

  test("get installs the default on first access and stores it under the key", () => {
    const ctx = createToolContext<{ cart?: Cart }>();
    expect(ctx.state.cart).toBeUndefined();
    expect(cartSlot.get(ctx)).toEqual({ items: [], nextId: 1 });
    expect(ctx.state.cart).toEqual({ items: [], nextId: 1 });
  });

  test("mutations to the returned value stick — it IS the stored object", () => {
    const ctx = createToolContext<{ cart?: Cart }>();
    cartSlot.get(ctx).items.push("apple");
    // The whole contract: a tool mutates what `get` returned and the next
    // tool call sees it. A `get` that returned a copy would pass every other
    // test in this file and lose every write.
    expect(cartSlot.get(ctx).items).toEqual(["apple"]);
    expect(ctx.state.cart?.items).toEqual(["apple"]);
  });

  test("get returns the same object across calls — the factory runs once", () => {
    let calls = 0;
    const slot = sessionSlot("counted", () => {
      calls += 1;
      return { n: calls };
    });
    const ctx = createToolContext<{ counted?: { n: number } }>();
    expect(slot.get(ctx)).toBe(slot.get(ctx));
    expect(calls).toBe(1);
  });

  test("two contexts are two sessions — neither sees the other's value", () => {
    const a = createToolContext<{ cart?: Cart }>();
    const b = createToolContext<{ cart?: Cart }>();
    cartSlot.get(a).items.push("apple");
    expect(cartSlot.get(b).items).toEqual([]);
  });

  test("a shared module-level default is not aliased when the factory clones", () => {
    const DEFAULT: Cart = { items: [], nextId: 1 };
    const slot = sessionSlot("cloned", () => structuredClone(DEFAULT));
    const a = createToolContext<{ cloned?: Cart }>();
    const b = createToolContext<{ cloned?: Cart }>();
    slot.get(a).items.push("apple");
    expect(slot.get(b).items).toEqual([]);
    expect(DEFAULT.items).toEqual([]);
  });

  test("set replaces the value wholesale and returns it", () => {
    const ctx = createToolContext<{ cart?: Cart }>();
    cartSlot.get(ctx).items.push("apple");
    const loaded: Cart = { items: ["pear"], nextId: 9 };
    expect(cartSlot.set(ctx, loaded)).toBe(loaded);
    expect(cartSlot.get(ctx)).toBe(loaded);
  });

  test("reset discards the value and installs a fresh default", () => {
    const ctx = createToolContext<{ cart?: Cart }>();
    cartSlot.get(ctx).items.push("apple");
    const fresh = cartSlot.reset(ctx);
    expect(fresh.items).toEqual([]);
    expect(cartSlot.get(ctx)).toBe(fresh);
  });

  test("reset returns a NEW object, not the mutated one cleared in place", () => {
    const ctx = createToolContext<{ cart?: Cart }>();
    const before = cartSlot.get(ctx);
    expect(cartSlot.reset(ctx)).not.toBe(before);
  });

  test("a slot holding undefined counts as absent", () => {
    // Reachable at runtime however the type is spelled — a JSON round-trip
    // through a save file, or a `state` factory that names the key without a
    // value. Installed with `Object.assign` (which copies an own property
    // holding `undefined`) because `exactOptionalPropertyTypes` will not let
    // `SlotState` say it.
    const ctx = createToolContext<{ cart?: Cart }>();
    Object.assign(ctx.state, { cart: undefined });
    expect("cart" in ctx.state).toBe(true);
    expect(cartSlot.get(ctx)).toEqual({ items: [], nextId: 1 });
  });

  describe("read", () => {
    test("returns the stored value when present", () => {
      const cart: Cart = { items: ["apple"], nextId: 2 };
      expect(cartSlot.read({ cart })).toBe(cart);
    });

    test("defaults for an empty state object", () => {
      expect(cartSlot.read({})).toEqual({ items: [], nextId: 1 });
    });

    test("defaults for undefined state", () => {
      expect(cartSlot.read(undefined)).toEqual({ items: [], nextId: 1 });
    });

    test("a slot holding a falsy value is not defaulted away", () => {
      // `read` and `get` must agree on what "absent" means, or a projection and
      // a tool see different state for the same session. Only `undefined`
      // counts — a `??` here would swallow `null` and `0`.
      const nullable = sessionSlot<"maybe", Cart | null>("maybe", () => emptyCart());
      expect(nullable.read({ maybe: null })).toBeNull();
      const zero = sessionSlot("count", () => 7);
      expect(zero.read({ count: 0 })).toBe(0);
    });

    test("does not install the default into the state it was handed", () => {
      // `read` is the `syncState` path — a projection must not mutate the
      // session it is projecting.
      const state: { cart?: Cart } = {};
      cartSlot.read(state);
      expect(state.cart).toBeUndefined();
    });
  });

  describe("projection", () => {
    const view = (cart: Cart) => ({ count: cart.items.length });

    test("projects the stored value", () => {
      const project = cartSlot.projection(view);
      expect(project({ cart: { items: ["a", "b"], nextId: 3 } })).toEqual({ count: 2 });
    });

    test("projects the default before anything is stored", () => {
      // This is what makes a client's empty-state fallback derivable from the
      // projection itself rather than hand-written.
      expect(cartSlot.projection(view)({})).toEqual({ count: 0 });
      expect(cartSlot.projection(view)(undefined)).toEqual({ count: 0 });
    });

    test("the projection sees a non-optional value", () => {
      // The point of `projection` over `read`: the callback's parameter is
      // `Cart`, so a projection needs no optional chaining. A type-level
      // claim, asserted at runtime by dereferencing without a guard.
      expect(cartSlot.projection((cart) => cart.items.length)(undefined)).toBe(0);
    });
  });

  test("two slots on one state object stay independent", () => {
    const other = sessionSlot("flags", () => ({ seen: false }));
    const ctx = createToolContext<{ cart?: Cart; flags?: { seen: boolean } }>();
    cartSlot.get(ctx).items.push("apple");
    other.get(ctx).seen = true;
    expect(ctx.state).toEqual({ cart: { items: ["apple"], nextId: 1 }, flags: { seen: true } });
  });
});
