// Copyright 2026 the AAI authors. MIT license.
import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { resolveAllBuiltins } from "./builtin-tools.ts";
import { readNotes, SESSION_NOTES_TTL_MS, writeNote } from "./session-notes.ts";

// The notes store is module-level (per host process), so each test uses
// session ids unique to it — there is no per-test store to construct.

describe("session notes, through remember/recall", () => {
  test("remember overwrites a key and notes are isolated per session", async () => {
    const { defs } = resolveAllBuiltins(["remember", "recall"]);
    const s1 = createToolContext({ sessionId: "notes-iso-1" });
    const s2 = createToolContext({ sessionId: "notes-iso-2" });

    await defs.remember?.execute({ key: "zip", value: "19122" }, s1);
    await defs.remember?.execute({ key: "zip", value: "94103" }, s1);
    expect(await defs.recall?.execute({ key: "zip" }, s1)).toEqual({ key: "zip", value: "94103" });
    expect(await defs.recall?.execute({}, s2)).toEqual({ notes: {} });
  });

  test("two concurrent remember calls both persist", async () => {
    const { defs } = resolveAllBuiltins(["remember", "recall"]);
    const ctx = createToolContext({ sessionId: "notes-concurrent" });

    // One LLM step's tool calls execute concurrently (pipeline streamText runs
    // them in parallel). Map updates are synchronous, so no per-key lock is
    // needed for both writes to land.
    await Promise.all([
      defs.remember?.execute({ key: "user_id", value: "usr_1" }, ctx),
      defs.remember?.execute({ key: "res_code", value: "BOB12" }, ctx),
    ]);

    expect(await defs.recall?.execute({}, ctx)).toEqual({
      notes: { user_id: "usr_1", res_code: "BOB12" },
    });
  });

  test("notes expire after the session-notes TTL", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { defs } = resolveAllBuiltins(["remember", "recall"]);
    const ctx = createToolContext({ sessionId: "notes-ttl" });

    await defs.remember?.execute({ key: "user_id", value: "usr_123" }, ctx);
    vi.advanceTimersByTime(SESSION_NOTES_TTL_MS - 1);
    expect(await defs.recall?.execute({}, ctx)).toEqual({ notes: { user_id: "usr_123" } });

    vi.advanceTimersByTime(2);
    expect(await defs.recall?.execute({}, ctx)).toEqual({ notes: {} });
  });
});

describe("readNotes / writeNote", () => {
  test("writeNote answers the session's whole record, and readNotes reads it back", () => {
    writeNote("notes-direct", "a", "1");
    expect(writeNote("notes-direct", "b", "2")).toEqual({ a: "1", b: "2" });
    expect(readNotes({ sessionId: "notes-direct" })).toEqual({ a: "1", b: "2" });
  });

  test("a session nothing wrote to reads as an empty record", () => {
    expect(readNotes({ sessionId: "notes-never-written" })).toEqual({});
  });

  test("a write refreshes the TTL, so a session in use does not expire under itself", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    writeNote("notes-refresh", "a", "1");
    vi.advanceTimersByTime(SESSION_NOTES_TTL_MS - 1);
    writeNote("notes-refresh", "b", "2");
    vi.advanceTimersByTime(SESSION_NOTES_TTL_MS - 1);
    expect(readNotes({ sessionId: "notes-refresh" })).toEqual({ a: "1", b: "2" });
  });
});
