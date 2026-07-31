// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, test } from "vitest";
import { clearStudioBuildCache, getCachedBuild, putCachedBuild } from "./studio-build-cache.ts";

beforeEach(() => {
  clearStudioBuildCache();
});

describe("studio build cache", () => {
  test("stores and returns builds by hash", () => {
    putCachedBuild("h1", { worker: "w1" });
    expect(getCachedBuild("h1")).toEqual({ worker: "w1" });
    expect(getCachedBuild("h2")).toBeNull();
  });

  test("merges the worker and client halves of one hash", () => {
    // test_agent stores the worker; a later Publish adds the client build.
    putCachedBuild("h1", { worker: "w1" });
    putCachedBuild("h1", { clientFiles: { "index.html": "<html>" } });
    expect(getCachedBuild("h1")).toEqual({
      worker: "w1",
      clientFiles: { "index.html": "<html>" },
    });
  });

  test("evicts the least recently used entry past the entry cap", () => {
    for (let i = 0; i < 8; i++) putCachedBuild(`h${i}`, { worker: `w${i}` });
    // Touch h0 so h1 becomes the least recently used.
    expect(getCachedBuild("h0")).toEqual({ worker: "w0" });
    putCachedBuild("h8", { worker: "w8" });
    expect(getCachedBuild("h1")).toBeNull();
    expect(getCachedBuild("h0")).toEqual({ worker: "w0" });
    expect(getCachedBuild("h8")).toEqual({ worker: "w8" });
  });

  test("evicts by byte budget, never the entry just stored", () => {
    const third = "x".repeat(22 * 1024 * 1024); // 3 × 22 MB > 64 MB budget
    putCachedBuild("h1", { worker: third });
    putCachedBuild("h2", { worker: third });
    putCachedBuild("h3", { worker: third });
    expect(getCachedBuild("h1")).toBeNull();
    expect(getCachedBuild("h2")).not.toBeNull();
    expect(getCachedBuild("h3")).not.toBeNull();
  });

  test("an entry larger than the whole budget is not cached", () => {
    putCachedBuild("huge", { worker: "x".repeat(65 * 1024 * 1024) });
    expect(getCachedBuild("huge")).toBeNull();
  });

  test("clear empties the cache", () => {
    putCachedBuild("h1", { worker: "w" });
    clearStudioBuildCache();
    expect(getCachedBuild("h1")).toBeNull();
  });
});
