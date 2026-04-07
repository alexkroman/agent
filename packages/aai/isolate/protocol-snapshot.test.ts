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
  HOOK_TIMEOUT_MS,
  TOOL_EXECUTION_TIMEOUT_MS,
} from "./constants.ts";
import type { ClientEvent, ClientMessage, ServerMessage } from "./protocol.ts";
import {
  AUDIO_FORMAT,
  ClientEventSchema,
  ClientMessageSchema,
  KvRequestSchema,
  SessionErrorCodeSchema,
} from "./protocol.ts";

// ── Constants ────────────────────────────────────────────────────────────

describe("protocol constants", () => {
  test("audio format", () => {
    expect(AUDIO_FORMAT).toMatchInlineSnapshot(`"pcm16"`);
  });

  test("sample rates", () => {
    expect(DEFAULT_STT_SAMPLE_RATE).toMatchInlineSnapshot("16000");
    expect(DEFAULT_TTS_SAMPLE_RATE).toMatchInlineSnapshot("24000");
  });

  test("timeout constants", () => {
    expect(HOOK_TIMEOUT_MS).toMatchInlineSnapshot("5000");
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

// ── Server → Client events (ClientEventSchema) ──────────────────────────

describe("server→client event wire format", () => {
  const valid: [string, ClientEvent][] = [
    ["speech_started", { type: "speech_started" }],
    ["speech_stopped", { type: "speech_stopped" }],
    ["user_transcript_delta", { type: "user_transcript_delta", text: "hello", isFinal: true }],
    [
      "user_transcript_delta (partial)",
      { type: "user_transcript_delta", text: "hel", isFinal: false },
    ],
    ["user_transcript", { type: "user_transcript", text: "hello world" }],
    ["user_transcript (with order)", { type: "user_transcript", text: "hello", turnOrder: 1 }],
    ["agent_transcript", { type: "agent_transcript", text: "response" }],
    ["agent_transcript_delta", { type: "agent_transcript_delta", text: "resp" }],
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
  ];

  test.each(valid)("%s parses successfully", (_label, event) => {
    const result = ClientEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  test("rejects unknown event type", () => {
    expect(ClientEventSchema.safeParse({ type: "bogus" }).success).toBe(false);
  });

  test("rejects invalid error code", () => {
    expect(
      ClientEventSchema.safeParse({ type: "error", code: "invalid_code", message: "x" }).success,
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

// ── Client → Server messages (ClientMessageSchema) ──────────────────────

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
    const result = ClientMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
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

// ── ServerMessage union (type check) ────────────────────────────────────

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

// ── KvRequestSchema ─────────────────────────────────────────────────────

describe("KvRequest wire format", () => {
  const valid = [
    ["get", { op: "get", key: "k1" }],
    ["set", { op: "set", key: "k1", value: "v1" }],
    ["set with ttl", { op: "set", key: "k1", value: "v1", ttl: 60 }],
    ["del", { op: "del", key: "k1" }],
    ["list", { op: "list", prefix: "user:" }],
    ["list with options", { op: "list", prefix: "", limit: 10, reverse: true }],
    ["keys", { op: "keys" }],
    ["keys with pattern", { op: "keys", pattern: "user:*" }],
  ] as const;

  test.each(valid)("%s parses successfully", (_label, req) => {
    expect(KvRequestSchema.safeParse(req).success).toBe(true);
  });

  test("rejects unknown op", () => {
    expect(KvRequestSchema.safeParse({ op: "update", key: "k1" }).success).toBe(false);
  });

  test("rejects empty key for get", () => {
    expect(KvRequestSchema.safeParse({ op: "get", key: "" }).success).toBe(false);
  });
});
