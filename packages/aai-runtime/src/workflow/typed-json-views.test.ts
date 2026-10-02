// Copyright 2026 the AAI authors. MIT license.
// `withPlainViews` on its own: which values it rebuilds, and that everything
// else comes back as the IDENTICAL object. The round trips through the codec
// are `typed-json.test.ts`'s "the withPlainViews pre-pass".

import { describe, expect, test } from "vitest";
import { isPlainObject, withPlainViews } from "./typed-json-views.ts";

describe("isPlainObject", () => {
  test("a literal and a null-prototype object are plain; class instances and arrays are not", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject([1])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });
});

describe("withPlainViews", () => {
  test("a Buffer becomes a plain Uint8Array over the SAME bytes, window included", () => {
    const pool = Buffer.alloc(16, 9);
    const window = pool.subarray(4, 8);
    const view = withPlainViews(window);
    expect(Buffer.isBuffer(view)).toBe(false);
    if (!(view instanceof Uint8Array)) throw new Error("expected a Uint8Array view");
    expect([...view]).toEqual([9, 9, 9, 9]);
    expect(view.buffer).toBe(pool.buffer);
  });

  test("only the path to a Buffer is copied; untouched siblings keep their identity", () => {
    const sibling = { id: "r1" };
    const input = { list: [sibling, Buffer.from([1])], other: sibling };
    const out = withPlainViews(input) as { list: unknown[]; other: unknown };
    expect(out).not.toBe(input);
    expect(out.list).not.toBe(input.list);
    expect(out.list[0]).toBe(sibling);
    expect(out.other).toBe(sibling);
    // The input itself is never mutated.
    expect(Buffer.isBuffer(input.list[1])).toBe(true);
  });

  test("a binary-free value, a plain view and a class instance come back unchanged", () => {
    const plain = { data: [{ id: 1 }], cursor: null };
    const bytes = new Uint8Array([1]);
    const date = new Date(0);
    expect(withPlainViews(plain)).toBe(plain);
    expect(withPlainViews(bytes)).toBe(bytes);
    expect(withPlainViews(date)).toBe(date);
  });

  test("past the depth cap the value is handed back untouched", () => {
    let node: Record<string, unknown> = { b: Buffer.from([1]) };
    const deepest = node;
    for (let i = 0; i < 40; i += 1) node = { next: node };
    let out = withPlainViews(node) as Record<string, unknown>;
    for (let i = 0; i < 40; i += 1) out = out.next as Record<string, unknown>;
    expect(out).toBe(deepest);
  });
});
