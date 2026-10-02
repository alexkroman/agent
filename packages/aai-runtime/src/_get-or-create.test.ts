// Copyright 2026 the AAI authors. MIT license.
/**
 * `getOrCreate`: the factory runs on a miss only, so a hit returns the entry
 * already recorded rather than a fresh one.
 */

import { describe, expect, test, vi } from "vitest";
import { getOrCreate } from "./_get-or-create.ts";

describe("getOrCreate", () => {
  test("creates and inserts on a miss", () => {
    const map = new Map<string, string[]>();
    const entry = getOrCreate(map, "s1", () => []);
    entry.push("a");
    expect(map.get("s1")).toEqual(["a"]);
  });

  test("a hit returns the existing entry and never calls the factory", () => {
    const map = new Map<string, string[]>([["s1", ["kept"]]]);
    const make = vi.fn(() => ["fresh"]);
    expect(getOrCreate(map, "s1", make)).toBe(map.get("s1"));
    expect(make).not.toHaveBeenCalled();
  });

  test("a falsy stored value is still a hit; only `undefined` is a miss", () => {
    const map = new Map<string, number>([["zero", 0]]);
    const make = vi.fn(() => 7);
    expect(getOrCreate(map, "zero", make)).toBe(0);
    expect(make).not.toHaveBeenCalled();
  });
});
