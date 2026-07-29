// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the guest-side session message cache: full replacement,
 * append verification, desync signalling, LRU bounding, and cleanup.
 * (Dependency-free module — no Deno shim needed.)
 */

import { describe, expect, test } from "vitest";
import { createSessionMessagesCache, MAX_MESSAGE_CACHE_SESSIONS } from "./harness-messages.ts";
import type { Message } from "./harness-types.ts";

function msg(content: string, role: Message["role"] = "user"): Message {
  return { role, content };
}

describe("createSessionMessagesCache", () => {
  test("full mode replaces the session's history", () => {
    const cache = createSessionMessagesCache();
    cache.apply("s1", [msg("old")], "full", undefined);

    const applied = cache.apply("s1", [msg("a"), msg("b")], "full", undefined);

    expect(applied).toEqual([msg("a"), msg("b")]);
  });

  test("absent mode (pre-delta callers) is treated as full", () => {
    const cache = createSessionMessagesCache();
    const applied = cache.apply("s1", [msg("legacy")], undefined, undefined);
    expect(applied).toEqual([msg("legacy")]);
  });

  test("append extends the cached history when the base matches", () => {
    const cache = createSessionMessagesCache();
    cache.apply("s1", [msg("a")], "full", undefined);

    const applied = cache.apply("s1", [msg("b"), msg("c")], "append", 1);

    expect(applied).toEqual([msg("a"), msg("b"), msg("c")]);
  });

  test("empty append returns the cached history unchanged", () => {
    const cache = createSessionMessagesCache();
    cache.apply("s1", [msg("a")], "full", undefined);

    const applied = cache.apply("s1", [], "append", 1);

    expect(applied).toEqual([msg("a")]);
  });

  test("append with a mismatched base desyncs (returns null)", () => {
    const cache = createSessionMessagesCache();
    cache.apply("s1", [msg("a")], "full", undefined);

    expect(cache.apply("s1", [msg("b")], "append", 2)).toBeNull();
  });

  test("append for an unknown session desyncs (returns null)", () => {
    const cache = createSessionMessagesCache();
    expect(cache.apply("fresh", [msg("b")], "append", 0)).toBeNull();
  });

  test("desync leaves the cache intact so a full resend recovers", () => {
    const cache = createSessionMessagesCache();
    cache.apply("s1", [msg("a")], "full", undefined);
    cache.apply("s1", [msg("b")], "append", 5);

    const applied = cache.apply("s1", [msg("a"), msg("b")], "full", undefined);
    expect(applied).toEqual([msg("a"), msg("b")]);
    expect(cache.apply("s1", [msg("c")], "append", 2)).toEqual([msg("a"), msg("b"), msg("c")]);
  });

  test("sessions are cached independently", () => {
    const cache = createSessionMessagesCache();
    cache.apply("s1", [msg("a")], "full", undefined);
    cache.apply("s2", [msg("x")], "full", undefined);

    expect(cache.apply("s1", [msg("b")], "append", 1)).toEqual([msg("a"), msg("b")]);
    expect(cache.apply("s2", [msg("y")], "append", 1)).toEqual([msg("x"), msg("y")]);
  });

  test("hands out a copy so tool mutation cannot corrupt the cache", () => {
    const cache = createSessionMessagesCache();
    const applied = cache.apply("s1", [msg("a")], "full", undefined);
    applied?.push(msg("injected"));
    applied?.splice(0, 1);

    expect(cache.apply("s1", [msg("b")], "append", 1)).toEqual([msg("a"), msg("b")]);
  });

  test("delete drops a session's history", () => {
    const cache = createSessionMessagesCache();
    cache.apply("s1", [msg("a")], "full", undefined);
    cache.delete("s1");

    expect(cache.size()).toBe(0);
    expect(cache.apply("s1", [msg("b")], "append", 1)).toBeNull();
  });

  test("evicts the least-recently-used session past the cap", () => {
    const cache = createSessionMessagesCache(2);
    cache.apply("s1", [msg("a")], "full", undefined);
    cache.apply("s2", [msg("b")], "full", undefined);
    // Touch s1 so s2 becomes the LRU entry.
    cache.apply("s1", [], "append", 1);
    cache.apply("s3", [msg("c")], "full", undefined);

    expect(cache.size()).toBe(2);
    // s2 was evicted: its next append desyncs (host will resend full).
    expect(cache.apply("s2", [msg("x")], "append", 1)).toBeNull();
    // s1 and s3 survived.
    expect(cache.apply("s1", [msg("y")], "append", 1)).toEqual([msg("a"), msg("y")]);
    expect(cache.apply("s3", [msg("z")], "append", 1)).toEqual([msg("c"), msg("z")]);
  });

  test("default cap bounds guest memory", () => {
    const cache = createSessionMessagesCache();
    for (let i = 0; i < MAX_MESSAGE_CACHE_SESSIONS + 5; i++) {
      cache.apply(`s${i}`, [msg(`m${i}`)], "full", undefined);
    }
    expect(cache.size()).toBe(MAX_MESSAGE_CACHE_SESSIONS);
  });
});
