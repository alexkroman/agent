import { describe, expect, test } from "vitest";
import { getOrCreateThread, setSessionId } from "./_state.ts";

describe("getOrCreateThread", () => {
  test("creates new thread with slug and isNew=true", () => {
    const thread = getOrCreateThread("new-ts-1");
    expect(thread.slug).toBeTruthy();
    expect(thread.slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(thread.isNew).toBe(true);
    expect(thread.sessionId).toBeUndefined();
  });

  test("returns existing thread with isNew=false", () => {
    const first = getOrCreateThread("existing-ts-1");
    const second = getOrCreateThread("existing-ts-1");
    expect(second.slug).toBe(first.slug);
    expect(second.isNew).toBe(false);
  });

  test("different thread_ts get different slugs", () => {
    const a = getOrCreateThread("thread-a");
    const b = getOrCreateThread("thread-b");
    expect(a.slug).not.toBe(b.slug);
  });
});

describe("setSessionId", () => {
  test("sets sessionId on existing thread", () => {
    const ts = "session-ts-1";
    getOrCreateThread(ts);
    setSessionId(ts, "session-123");
    const thread = getOrCreateThread(ts);
    expect(thread.sessionId).toBe("session-123");
  });

  test("no-ops for unknown thread", () => {
    // Should not throw
    setSessionId("unknown-ts", "session-456");
  });
});
