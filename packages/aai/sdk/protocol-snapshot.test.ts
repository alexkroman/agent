// Copyright 2025 the AAI authors. MIT license.
/**
 * Wire format snapshot tests for the WebSocket protocol.
 *
 * These ensure that changes to Zod schemas in protocol.ts don't
 * accidentally alter the wire format. If a snapshot breaks, it
 * signals a potentially breaking protocol change.
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  TOOL_EXECUTION_TIMEOUT_MS,
} from "./constants.ts";
import type { ClientEvent, ClientMessage, ServerMessage } from "./protocol.ts";
import { ClientEventSchema, ClientMessageSchema, SessionErrorCodeSchema } from "./protocol.ts";

describe("protocol constants", () => {
  test("sample rates", () => {
    expect(DEFAULT_STT_SAMPLE_RATE).toMatchInlineSnapshot("16000");
    expect(DEFAULT_TTS_SAMPLE_RATE).toMatchInlineSnapshot("24000");
  });

  test("timeout constants", () => {
    expect(TOOL_EXECUTION_TIMEOUT_MS).toMatchInlineSnapshot("30000");
  });

  test("error codes", () => {
    expect(SessionErrorCodeSchema.options).toMatchInlineSnapshot(`
      [
        "stt",
        "llm",
        "tts",
        "tool",
        "protocol",
        "connection",
        "audio",
        "internal",
      ]
    `);
  });
});

describe("server→client event wire format", () => {
  const valid: [string, ClientEvent][] = [
    ["speech_started", { type: "speech_started" }],
    ["speech_stopped", { type: "speech_stopped" }],
    ["user_transcript", { type: "user_transcript", text: "hello" }],
    ["agent_transcript", { type: "agent_transcript", text: "response" }],
    [
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "web_search",
        args: { query: "weather" },
      },
    ],
    ["tool_call_done", { type: "tool_call_done", toolCallId: "tc1", result: "72F" }],
    ["reply_done", { type: "reply_done" }],
    ["cancelled", { type: "cancelled" }],
    ["reset", { type: "reset" }],
    ["idle_timeout", { type: "idle_timeout" }],
    ["error", { type: "error", code: "stt", message: "Speech recognition failed" }],
    ["custom_event", { type: "custom_event", event: "game_state", data: { hp: 10 } }],
  ];

  test.each(valid)("%s parses successfully", (_label, event) => {
    expect(ClientEventSchema.safeParse(event).success).toBe(true);
  });

  test("rejects unknown event type", () => {
    expect(ClientEventSchema.safeParse({ type: "bogus" }).success).toBe(false);
  });

  test("rejects invalid error code", () => {
    expect(
      ClientEventSchema.safeParse({ type: "error", code: "invalid_code", message: "x" }).success,
    ).toBe(false);
  });

  test("rejects custom_event with empty event name", () => {
    expect(
      ClientEventSchema.safeParse({ type: "custom_event", event: "", data: null }).success,
    ).toBe(false);
  });

  test("rejects tool_call_done with oversized result", () => {
    expect(
      ClientEventSchema.safeParse({
        type: "tool_call_done",
        toolCallId: "tc1",
        result: "x".repeat(4001),
      }).success,
    ).toBe(false);
  });
});

describe("client→server message wire format", () => {
  const valid: [string, ClientMessage][] = [
    ["audio_ready", { type: "audio_ready" }],
    ["cancel", { type: "cancel" }],
    ["reset", { type: "reset" }],
    [
      "history",
      {
        type: "history",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
        ],
      },
    ],
  ];

  test.each(valid)("%s parses successfully", (_label, msg) => {
    expect(ClientMessageSchema.safeParse(msg).success).toBe(true);
  });

  test("rejects unknown message type", () => {
    expect(ClientMessageSchema.safeParse({ type: "bogus" }).success).toBe(false);
  });

  test("rejects history with invalid role", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "history",
        messages: [{ role: "system", text: "nope" }],
      }).success,
    ).toBe(false);
  });

  test("rejects history exceeding 200 messages", () => {
    const messages = Array.from({ length: 201 }, (_, i) => ({
      role: "user" as const,
      text: `msg ${i}`,
    }));
    expect(ClientMessageSchema.safeParse({ type: "history", messages }).success).toBe(false);
  });
});

describe("ServerMessage type covers all variants", () => {
  test("config message shape", () => {
    const msg: ServerMessage = {
      type: "config",
      audioFormat: "pcm16",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
    };
    expect(msg.type).toBe("config");
  });

  test("audio_done message shape", () => {
    const msg: ServerMessage = { type: "audio_done" };
    expect(msg.type).toBe("audio_done");
  });

  test("ClientEvent is a valid ServerMessage", () => {
    const msg: ServerMessage = { type: "speech_started" };
    expect(msg.type).toBe("speech_started");
  });
});
