// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { collectBytes, concatBytes } from "./_bytes.ts";

describe("concatBytes", () => {
  test("joins the parts in order", () => {
    const joined = concatBytes([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
    expect([...joined]).toEqual([1, 2, 3]);
  });

  test("answers an empty array for no parts", () => {
    expect(concatBytes([]).byteLength).toBe(0);
  });

  test("reads each part's VIEW, not its whole backing buffer", () => {
    const backing = new Uint8Array([9, 1, 2, 9]);
    expect([...concatBytes([backing.subarray(1, 3)])]).toEqual([1, 2]);
  });

  test("copies, so mutating a part afterwards leaves the result alone", () => {
    const part = new Uint8Array([1]);
    const joined = concatBytes([part]);
    part[0] = 7;
    expect([...joined]).toEqual([1]);
  });
});

describe("collectBytes", () => {
  test("drains an async iterable into one array", async () => {
    async function* chunks() {
      yield new Uint8Array([1]);
      yield new Uint8Array([2, 3]);
    }
    expect([...(await collectBytes(chunks()))]).toEqual([1, 2, 3]);
  });
});
