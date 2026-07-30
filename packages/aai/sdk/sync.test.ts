// Copyright 2026 the AAI authors. MIT license.
// Sync-turn wire-format validation rules.

import { describe, expect, test } from "vitest";
import { MAX_SYNC_HISTORY_MESSAGES } from "./constants.ts";
import { SyncTurnRequestSchema, SyncTurnResponseSchema } from "./sync.ts";

describe("SyncTurnRequestSchema", () => {
  test("accepts a text turn and defaults history", () => {
    const parsed = SyncTurnRequestSchema.parse({ text: "hello" });
    expect(parsed.text).toBe("hello");
    expect(parsed.history).toEqual([]);
  });

  test("accepts an audio turn with sampleRate and history", () => {
    const parsed = SyncTurnRequestSchema.parse({
      audio: "AAEC",
      sampleRate: 16_000,
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(parsed.audio).toBe("AAEC");
    expect(parsed.history).toHaveLength(2);
  });

  const invalidBodies: [unknown, string][] = [
    [{}, "neither text nor audio"],
    [{ text: "a", audio: "AAEC", sampleRate: 16_000 }, "both text and audio"],
    [{ audio: "AAEC" }, "audio without sampleRate"],
    [{ text: "" }, "empty text"],
    [{ text: "a", history: [{ role: "tool", content: "x" }] }, "non-user/assistant role"],
    [{ text: "a", sampleRate: 1_000_000 }, "absurd sample rate"],
  ];
  test.each(invalidBodies)("rejects %o (%s)", (body) => {
    expect(SyncTurnRequestSchema.safeParse(body).success).toBe(false);
  });

  test("rejects history beyond the cap", () => {
    const history = Array.from({ length: MAX_SYNC_HISTORY_MESSAGES + 1 }, () => ({
      role: "user" as const,
      content: "x",
    }));
    expect(SyncTurnRequestSchema.safeParse({ text: "a", history }).success).toBe(false);
  });
});

describe("SyncTurnResponseSchema", () => {
  test("accepts text-only and spoken responses", () => {
    expect(SyncTurnResponseSchema.safeParse({ transcript: "t", reply: "r" }).success).toBe(true);
    expect(
      SyncTurnResponseSchema.safeParse({
        transcript: "t",
        reply: "r",
        audio: "AAEC",
        sampleRate: 24_000,
      }).success,
    ).toBe(true);
    expect(
      SyncTurnResponseSchema.safeParse({ transcript: "t", reply: "r", ttsError: "down" }).success,
    ).toBe(true);
  });

  test("rejects a response missing the reply", () => {
    expect(SyncTurnResponseSchema.safeParse({ transcript: "t" }).success).toBe(false);
  });

  test("accepts the turn's tool calls, with and without results", () => {
    const parsed = SyncTurnResponseSchema.parse({
      transcript: "t",
      reply: "r",
      toolCalls: [
        { toolCallId: "c1", toolName: "lookup", args: { q: "x" }, result: "42" },
        { toolCallId: "c2", toolName: "save", args: {} },
      ],
    });
    expect(parsed.toolCalls).toHaveLength(2);
    // Optional on the wire — older servers omit it entirely.
    expect(SyncTurnResponseSchema.parse({ transcript: "t", reply: "r" }).toolCalls).toBeUndefined();
  });

  test("rejects a malformed tool-call record", () => {
    expect(
      SyncTurnResponseSchema.safeParse({
        transcript: "t",
        reply: "r",
        toolCalls: [{ toolName: "lookup", args: {} }],
      }).success,
    ).toBe(false);
  });
});
