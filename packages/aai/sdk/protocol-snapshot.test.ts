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
import {
  ClientEventSchema,
  ClientMessageSchema,
  KvRequestSchema,
  SessionErrorCodeSchema,
  VectorRequestSchema,
} from "./protocol.ts";

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
    ["user_transcript (with order)", { type: "user_transcript", text: "hello", turnOrder: 1 }],
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

describe("KvRequest wire format", () => {
  const valid = [
    ["get", { op: "get", key: "k1" }],
    ["set", { op: "set", key: "k1", value: "v1" }],
    ["set with expireIn", { op: "set", key: "k1", value: "v1", expireIn: 60_000 }],
    ["del", { op: "del", key: "k1" }],
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

describe("VectorRequest wire format", () => {
  const valid = [
    ["upsert", { op: "upsert", id: "doc-1", text: "hello" }],
    ["upsert with metadata", { op: "upsert", id: "doc-2", text: "world", metadata: { tag: "x" } }],
    ["query", { op: "query", text: "search query" }],
    ["query with topK", { op: "query", text: "search query", topK: 10 }],
    ["delete single id", { op: "delete", ids: "doc-1" }],
    ["delete multiple ids", { op: "delete", ids: ["doc-1", "doc-2"] }],
  ] as const;

  test.each(valid)("%s parses successfully", (_label, req) => {
    expect(VectorRequestSchema.safeParse(req).success).toBe(true);
  });

  test("rejects unknown op", () => {
    expect(VectorRequestSchema.safeParse({ op: "scan", text: "x" }).success).toBe(false);
  });

  test("rejects upsert with empty id", () => {
    expect(VectorRequestSchema.safeParse({ op: "upsert", id: "", text: "hello" }).success).toBe(
      false,
    );
  });

  test("rejects upsert with empty text", () => {
    expect(VectorRequestSchema.safeParse({ op: "upsert", id: "doc-1", text: "" }).success).toBe(
      false,
    );
  });

  test("rejects query with empty text", () => {
    expect(VectorRequestSchema.safeParse({ op: "query", text: "" }).success).toBe(false);
  });

  test("rejects query with topK > 100", () => {
    expect(VectorRequestSchema.safeParse({ op: "query", text: "hello", topK: 101 }).success).toBe(
      false,
    );
  });

  test("rejects delete with empty id string", () => {
    expect(VectorRequestSchema.safeParse({ op: "delete", ids: "" }).success).toBe(false);
  });

  test("rejects delete with > 1000 ids", () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    expect(VectorRequestSchema.safeParse({ op: "delete", ids }).success).toBe(false);
  });
});
