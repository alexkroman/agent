// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { claimKey, type KeyOwner, shapeOf } from "./_slot-owners.ts";
import { createDetachedSlotStore } from "./session-state.ts";

describe("shapeOf", () => {
  test.each([
    [() => ({ b: 1, a: 2 }), "{a,b}"],
    [() => [], "array"],
    [() => null, "null"],
    [() => 0, "number"],
    [() => "s", "string"],
    [() => undefined, "undefined"],
  ])("describes %s as %j, with record keys sorted", (create, shape) => {
    expect(shapeOf(create)).toBe(shape);
  });

  test("answers undefined for a factory that throws, rather than guessing", () => {
    expect(
      shapeOf(() => {
        throw new Error("boom");
      }),
    ).toBeUndefined();
  });
});

/** A claim by a fresh declaration whose factory makes `value`. */
const claimFor = (value: unknown): KeyOwner => ({ owner: {}, shape: () => shapeOf(() => value) });

describe("claimKey", () => {
  test("refuses a second declaration of the key that stores a different shape", () => {
    const store = createDetachedSlotStore();
    claimKey(store, "cart", claimFor({ items: [] }));
    expect(() => claimKey(store, "cart", claimFor([]))).toThrow(
      /Two slots share the key "cart".*one stores \{items\}, the other array/,
    );
  });

  test("lets the same declaration claim its key again", () => {
    const store = createDetachedSlotStore();
    const claim = claimFor({ items: [] });
    claimKey(store, "cart", claim);
    expect(() => claimKey(store, "cart", { ...claim, shape: () => "array" })).not.toThrow();
  });

  test("lets two declarations that agree on the shape share a key", () => {
    const store = createDetachedSlotStore();
    claimKey(store, "cart", claimFor({ items: [] }));
    expect(() => claimKey(store, "cart", claimFor({ items: [1] }))).not.toThrow();
  });

  test("does not refuse when either shape is unknown", () => {
    const store = createDetachedSlotStore();
    claimKey(store, "cart", { owner: {}, shape: () => undefined });
    expect(() => claimKey(store, "cart", claimFor([]))).not.toThrow();
  });

  test("tracks owners per store, so two sessions never collide", () => {
    claimKey(createDetachedSlotStore(), "cart", claimFor({ items: [] }));
    expect(() => claimKey(createDetachedSlotStore(), "cart", claimFor([]))).not.toThrow();
  });
});
