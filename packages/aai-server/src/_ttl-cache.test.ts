// Copyright 2026 the AAI authors. MIT license.
/**
 * The contract three call sites read as `cached !== undefined`, plus the two
 * properties that moving off quick-lru was for.
 *
 * There was no spec for this module at all while it was a four-line subclass,
 * which was defensible then and is not now: `null` survives a round trip only
 * because of an internal sentinel, and the cap is only exact because of the
 * library underneath.
 */

import { expect, test, vi } from "vitest";
import { TtlCache } from "./_ttl-cache.ts";

test("null is a cached VALUE and a miss is undefined", () => {
  const cache = new TtlCache<string | null>(60_000);
  cache.set("negative", null);

  // The distinction the bundle store and the token cache both depend on: a
  // cached "asked, and the answer was nothing" must not read as "never asked".
  expect(cache.get("negative")).toBeNull();
  expect(cache.get("never-set")).toBeUndefined();
});

test("storing undefined throws rather than silently not writing", () => {
  // The one instantiation that can express it — every real one narrows `V` to
  // something `undefined` is not. lru-cache treats `set(k, undefined)` as a
  // no-op, which would read as a cache that never hits, so it has to be loud.
  const cache = new TtlCache<string | undefined>(60_000);
  expect(() => cache.set("k", undefined)).toThrow(/undefined/);
});

test("the entry cap is EXACT, which is what quick-lru's was not", () => {
  const cache = new TtlCache<number>(60_000, 3);
  for (const [index, key] of ["a", "b", "c", "d"].entries()) cache.set(key, index);

  // Four writes into a cache of three: the oldest is gone and the rest are
  // held. quick-lru's dual-generation eviction would still be holding "a".
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toBe(1);
  expect(cache.get("d")).toBe(3);
});

test("an entry expires on read once its TTL has passed", () => {
  const cache = new TtlCache<string>(5000);
  cache.set("k", "v");
  expect(cache.get("k")).toBe("v");

  vi.useFakeTimers();
  try {
    vi.advanceTimersByTime(6000);
    expect(cache.get("k")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("a per-entry ttlMs overrides the cache default, in both directions", () => {
  const cache = new TtlCache<string>(60_000);
  // The `verifyAccessToken` shape: a short-lived entry beside a default-lived
  // one, where the caller's own expiry is the shorter of the two.
  cache.set("short", "v", { ttlMs: 1000 });
  cache.set("default", "v");

  vi.useFakeTimers();
  try {
    vi.advanceTimersByTime(2000);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("default")).toBe("v");
  } finally {
    vi.useRealTimers();
  }
});

test("delete removes an entry and is a no-op on one that is absent", () => {
  const cache = new TtlCache<string>(60_000);
  cache.set("k", "v");
  cache.delete("k");
  expect(cache.get("k")).toBeUndefined();
  expect(() => cache.delete("gone")).not.toThrow();
});
