// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createOwnedMap } from "./owned-map.ts";

describe("createOwnedMap", () => {
  test("claim installs the entry and release removes it", () => {
    const map = createOwnedMap<string, string>();
    const release = map.claim("k", "v");
    expect(map.get("k")).toBe("v");
    expect(map.has("k")).toBe(true);
    expect(map.size).toBe(1);
    expect(release()).toBe(true);
    expect(map.get("k")).toBeUndefined();
    expect(map.size).toBe(0);
  });

  test("a stale claim's release does not evict the successor — the invariant this type exists for", () => {
    const map = createOwnedMap<string, string>();
    const releaseOld = map.claim("session", "old");
    map.claim("session", "new");
    // The old owner's async teardown settles late and releases.
    expect(releaseOld()).toBe(false);
    expect(map.get("session")).toBe("new");
  });

  test("release is idempotent", () => {
    const map = createOwnedMap<string, string>();
    const release = map.claim("k", "v");
    expect(release()).toBe(true);
    expect(release()).toBe(false);
  });

  test.each(["same primitive", { session: "same object" }, Number.NaN, undefined])(
    "a repeated value has a fresh claim: %j",
    (value) => {
      const map = createOwnedMap<string, typeof value>();
      const releaseOld = map.claim("session", value);
      const releaseNew = map.claim("session", value);
      expect(releaseOld()).toBe(false);
      expect(map.has("session")).toBe(true);
      expect(map.owns("session", value)).toBe(true);
      expect(releaseNew()).toBe(true);
      expect(map.owns("session", value)).toBe(false);
    },
  );

  test.each(["delete", "clear"] as const)(
    "a claim removed by %s cannot release a later identical value",
    (remove) => {
      const map = createOwnedMap<string, string>();
      const releaseOld = map.claim("session", "same");
      if (remove === "delete") map.delete("session");
      else map.clear();
      map.claim("session", "same");
      expect(releaseOld()).toBe(false);
      expect(map.get("session")).toBe("same");
    },
  );

  test("owns reports whether a value still holds its key", () => {
    const map = createOwnedMap<string, string>();
    map.claim("k", "a");
    expect(map.owns("k", "a")).toBe(true);
    map.claim("k", "b");
    expect(map.owns("k", "a")).toBe(false);
    expect(map.owns("k", "b")).toBe(true);
  });

  test("delete removes unconditionally (owner-driven flows)", () => {
    const map = createOwnedMap<string, string>();
    const release = map.claim("k", "v");
    expect(map.delete("k")).toBe(true);
    expect(release()).toBe(false);
  });

  test("keys/values/clear behave like a Map", () => {
    const map = createOwnedMap<string, number>();
    map.claim("a", 1);
    map.claim("b", 2);
    expect([...map.keys()]).toEqual(["a", "b"]);
    expect([...map.values()]).toEqual([1, 2]);
    map.clear();
    expect(map.size).toBe(0);
  });
});
