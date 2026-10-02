// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { MAX_TRANSCRIPT_CHARS } from "./constants.ts";
import { SESSION_COMMAND_TYPES, SessionCommandSchema } from "./protocol-commands.ts";

describe("SessionCommandSchema", () => {
  test("accepts audio_ready", () => {
    const result = SessionCommandSchema.safeParse({ type: "audio_ready" });
    expect(result.success).toBe(true);
  });

  test("accepts cancel", () => {
    const result = SessionCommandSchema.safeParse({ type: "cancel" });
    expect(result.success).toBe(true);
  });

  test("accepts reset", () => {
    const result = SessionCommandSchema.safeParse({ type: "reset" });
    expect(result.success).toBe(true);
  });

  test.each(["user_turn_start", "user_turn_commit", "user_turn_clear"])(
    "accepts the push-to-talk command %s",
    (type) => {
      expect(SessionCommandSchema.safeParse({ type }).success).toBe(true);
    },
  );

  describe("user_text", () => {
    test("accepts a typed turn and hands the server its text trimmed", () => {
      // Trimmed at the schema so every consumer — the dispatcher, the transport,
      // the event it becomes — sees the same string, not one each trims itself.
      const result = SessionCommandSchema.safeParse({ type: "user_text", text: "  hi there \n" });
      expect(result.success && result.data).toEqual({ type: "user_text", text: "hi there" });
    });

    test.each([
      ["empty", ""],
      ["whitespace only", "   \n\t"],
    ])("rejects %s text: a turn with nothing in it is not a turn", (_label, text) => {
      expect(SessionCommandSchema.safeParse({ type: "user_text", text }).success).toBe(false);
    });

    test("rejects rather than truncates past the transcript cap it becomes", () => {
      // The text becomes a `userTranscript.committed`, whose own cap is this
      // one — so a command that parsed here could never produce an event that
      // did not.
      const at = "x".repeat(MAX_TRANSCRIPT_CHARS);
      expect(SessionCommandSchema.safeParse({ type: "user_text", text: at }).success).toBe(true);
      expect(SessionCommandSchema.safeParse({ type: "user_text", text: `${at}x` }).success).toBe(
        false,
      );
    });

    test("rejects a missing or non-string text", () => {
      expect(SessionCommandSchema.safeParse({ type: "user_text" }).success).toBe(false);
      expect(SessionCommandSchema.safeParse({ type: "user_text", text: 42 }).success).toBe(false);
    });

    test("is a recognised command type, so an invalid one warns instead of vanishing", () => {
      expect(SESSION_COMMAND_TYPES.has("user_text")).toBe(true);
    });
  });

  test("accepts playback_progress", () => {
    const result = SessionCommandSchema.safeParse({ type: "playback_progress", bufferedMs: 250 });
    expect(result.success).toBe(true);
  });

  test("rejects unknown type", () => {
    const result = SessionCommandSchema.safeParse({
      type: "unknown_message_type",
    });
    expect(result.success).toBe(false);
  });
});
