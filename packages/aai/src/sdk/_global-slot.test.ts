// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test } from "vitest";
import { globalSlot } from "./_global-slot.ts";

const KEY = "@alexkroman1/aai.test.globalSlot";

afterEach(() => globalSlot<number>(KEY).set(undefined));

describe("globalSlot", () => {
  test("two handles on one key share the value, as two bundle copies must", () => {
    globalSlot<number>(KEY).set(7);
    expect(globalSlot<number>(KEY).get()).toBe(7);
    expect(Reflect.get(globalThis, Symbol.for(KEY))).toBe(7);
  });

  test("set(undefined) deletes the property rather than storing undefined", () => {
    const slot = globalSlot<number>(KEY);
    slot.set(1);
    slot.set(undefined);
    expect(slot.get()).toBeUndefined();
    expect(Object.getOwnPropertySymbols(globalThis)).not.toContain(Symbol.for(KEY));
  });
});
