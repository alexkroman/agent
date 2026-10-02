// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createDetachedSlotStore, freezeStorable, SlotValueError } from "./session-state.ts";

describe("freezeStorable", () => {
  test("answers the same value, deep-frozen", () => {
    const value = { cart: { items: [{ sku: "a" }] }, note: null };
    expect(freezeStorable(value, "cart")).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.cart.items)).toBe(true);
    expect(Object.isFrozen(value.cart.items[0])).toBe(true);
  });

  test("lets an absent-or-undefined property through, since JSON drops it either way", () => {
    expect(() => freezeStorable({ a: undefined, b: 1 }, "s")).not.toThrow();
  });

  test("accepts a shared (non-circular) reference twice", () => {
    const shared = { n: 1 };
    expect(() => freezeStorable({ a: shared, b: shared }, "s")).not.toThrow();
  });

  test.each([
    [{ when: new Date(0) }, "s.when is a Date"],
    [{ seen: new Map() }, "s.seen is a Map"],
    [{ n: Number.NaN }, "s.n is NaN, which JSON stores as null"],
    [{ list: [1, undefined] }, "s.list[1] is undefined"],
    [{ f: () => 1 }, "s.f is a function, which cannot be stored"],
    [{ big: 1n }, "s.big is a bigint"],
  ])("refuses %o, naming the PATH", (value, message) => {
    expect(() => freezeStorable(value, "s")).toThrow(SlotValueError);
    expect(() => freezeStorable(value, "s")).toThrow(message);
  });

  test("refuses a cycle by path, where JSON.stringify names none", () => {
    const loop: { self?: unknown } = {};
    loop.self = loop;
    expect(() => freezeStorable(loop, "s")).toThrow("s.self is a circular reference");
  });

  test("refuses a class instance, which does not survive being stored", () => {
    class Cart {
      items = [];
    }
    expect(() => freezeStorable({ cart: new Cart() }, "s")).toThrow("s.cart is a Cart instance");
  });
});

describe("createDetachedSlotStore", () => {
  test("reads back what was written, and nothing for an unwritten key", () => {
    const store = createDetachedSlotStore();
    store.write("cart", { items: 1 }, true);
    expect(store.read("cart")).toEqual({ items: 1 });
    expect(store.read("other")).toBeUndefined();
  });

  test("checks and freezes a durable write, and leaves an ephemeral one alone", () => {
    const store = createDetachedSlotStore();
    expect(() => store.write("d", { at: new Date(0) }, true)).toThrow(SlotValueError);
    const ephemeral = { at: new Date(0) };
    store.write("e", ephemeral, false);
    expect(store.read("e")).toBe(ephemeral);
    expect(Object.isFrozen(ephemeral)).toBe(false);
  });

  test("two stores share nothing", () => {
    const a = createDetachedSlotStore();
    a.write("k", 1, true);
    expect(createDetachedSlotStore().read("k")).toBeUndefined();
  });
});
