import fc from "fast-check";
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  TOOL_EXECUTION_TIMEOUT_MS,
} from "./constants.ts";
import type { ClientEvent, ServerMessage } from "./protocol.ts";
import {
  buildReadyConfig,
  ClientEventSchema,
  ClientMessageSchema,
  KvRequestSchema,
  lenientParse,
  SessionErrorCodeSchema,
  VectorRequestSchema,
} from "./protocol.ts";

describe("protocol constants", () => {
  test("DEFAULT_STT_SAMPLE_RATE is 16000", () => {
    expect(DEFAULT_STT_SAMPLE_RATE).toBe(16_000);
  });

  test("DEFAULT_TTS_SAMPLE_RATE is 24000", () => {
    expect(DEFAULT_TTS_SAMPLE_RATE).toBe(24_000);
  });

  test("TOOL_EXECUTION_TIMEOUT_MS is 30000", () => {
    expect(TOOL_EXECUTION_TIMEOUT_MS).toBe(30_000);
  });
});

describe("KvRequestSchema", () => {
  test("accepts valid get request", () => {
    const result = KvRequestSchema.safeParse({
      op: "get",
      key: "my-key",
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid set request with ttl", () => {
    const result = KvRequestSchema.safeParse({
      op: "set",
      key: "my-key",
      value: "my-value",
      ttl: 3600,
    });
    expect(result.success).toBe(true);
  });

  // The Kv interface accepts `value: unknown` — ensure the schema matches.
  test.each([
    { nested: true },
    [1, 2, 3],
    null,
    42,
  ])("set accepts non-string value: %j", (value) => {
    const result = KvRequestSchema.safeParse({ op: "set", key: "k", value });
    expect(result.success).toBe(true);
  });

  test("rejects empty key on get", () => {
    const result = KvRequestSchema.safeParse({
      op: "get",
      key: "",
    });
    expect(result.success).toBe(false);
  });
});

const ERROR_CODES = [
  "stt",
  "llm",
  "tts",
  "tool",
  "protocol",
  "connection",
  "audio",
  "internal",
] as const;

describe("SessionErrorCodeSchema", () => {
  test.each(ERROR_CODES)("accepts valid code: %s", (code) => {
    expect(SessionErrorCodeSchema.safeParse(code).success).toBe(true);
  });

  test("rejects invalid code", () => {
    expect(SessionErrorCodeSchema.safeParse("not_a_real_code").success).toBe(false);
  });
});

describe("ClientEventSchema", () => {
  test("accepts speech_started", () => {
    expect({ type: "speech_started" }).toBeValidClientEvent();
  });

  test("accepts user_transcript", () => {
    expect({ type: "user_transcript", text: "hello world" }).toBeValidClientEvent();
  });

  test("accepts error event", () => {
    expect({
      type: "error",
      code: "internal",
      message: "something went wrong",
    }).toBeValidClientEvent();
  });

  test("rejects unknown type", () => {
    expect({ type: "unknown_event_type" }).not.toBeValidClientEvent();
  });
});

describe("ClientMessageSchema", () => {
  test("accepts audio_ready", () => {
    const result = ClientMessageSchema.safeParse({ type: "audio_ready" });
    expect(result.success).toBe(true);
  });

  test("accepts cancel", () => {
    const result = ClientMessageSchema.safeParse({ type: "cancel" });
    expect(result.success).toBe(true);
  });

  test("accepts reset", () => {
    const result = ClientMessageSchema.safeParse({ type: "reset" });
    expect(result.success).toBe(true);
  });

  test("accepts history with messages", () => {
    const result = ClientMessageSchema.safeParse({
      type: "history",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown type", () => {
    const result = ClientMessageSchema.safeParse({
      type: "unknown_message_type",
    });
    expect(result.success).toBe(false);
  });
});

describe("buildReadyConfig", () => {
  test("builds config from sample rates", () => {
    const config = buildReadyConfig({ inputSampleRate: 16_000, outputSampleRate: 24_000 });
    expect(config).toEqual({
      audioFormat: "pcm16",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
    });
  });

  test("uses custom sample rates", () => {
    const config = buildReadyConfig({ inputSampleRate: 8000, outputSampleRate: 48_000 });
    expect(config.sampleRate).toBe(8000);
    expect(config.ttsSampleRate).toBe(48_000);
  });
});

// ── Property-based tests ─────────────────────────────────────────────────

describe("property: lenientParse", () => {
  test("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = lenientParse(ClientEventSchema, input);
        expect(result).toHaveProperty("ok");
      }),
    );
  });

  test("valid ClientEvents round-trip through parse", () => {
    const speechStartedArb = fc.constant({ type: "speech_started" as const });

    const userTranscriptArb = fc.record({
      type: fc.constant("user_transcript" as const),
      text: fc.string(),
    });

    const errorEventArb = fc.record({
      type: fc.constant("error" as const),
      code: fc.constantFrom(...ERROR_CODES),
      message: fc.string(),
    });

    const clientEventArb = fc.oneof(speechStartedArb, userTranscriptArb, errorEventArb);

    fc.assert(
      fc.property(clientEventArb, (event) => {
        const result = lenientParse(ClientEventSchema, event);
        expect(result.ok).toBe(true);
      }),
    );
  });

  test("objects without type field are malformed", () => {
    const noTypeArb = fc.object().filter((obj) => !("type" in obj));

    fc.assert(
      fc.property(noTypeArb, (obj) => {
        const result = lenientParse(ClientEventSchema, obj);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.malformed).toBe(true);
        }
      }),
    );
  });
});

describe("protocol type contracts", () => {
  test("ClientEvent narrows on user_transcript discriminant", () => {
    type UserTranscript = Extract<ClientEvent, { type: "user_transcript" }>;
    expectTypeOf<UserTranscript>().toHaveProperty("text");
    expectTypeOf<UserTranscript["text"]>().toBeString();
  });

  test("ClientEvent narrows on tool_call discriminant", () => {
    type ToolCall = Extract<ClientEvent, { type: "tool_call" }>;
    expectTypeOf<ToolCall>().toHaveProperty("toolCallId");
    expectTypeOf<ToolCall>().toHaveProperty("toolName");
    expectTypeOf<ToolCall>().toHaveProperty("args");
  });

  test("ClientEvent narrows on error discriminant", () => {
    type ErrorEvent = Extract<ClientEvent, { type: "error" }>;
    expectTypeOf<ErrorEvent>().toHaveProperty("code");
    expectTypeOf<ErrorEvent>().toHaveProperty("message");
  });

  test("ServerMessage has type property on all variants", () => {
    expectTypeOf<ServerMessage>().toHaveProperty("type");
  });

  test("lenientParse returns ok/error discriminated union", () => {
    const schema = z.object({ type: z.literal("test"), value: z.number() });
    type Parsed = z.infer<typeof schema>;
    const result = lenientParse(schema, {});
    expectTypeOf(result).toEqualTypeOf<
      { ok: true; data: Parsed } | { ok: false; malformed: boolean; error: string }
    >();
  });
});

describe("VectorRequestSchema", () => {
  test("accepts upsert", () => {
    const r = VectorRequestSchema.parse({
      op: "upsert",
      id: "doc-1",
      text: "hello",
      metadata: { tag: "x" },
    });
    expect(r.op).toBe("upsert");
  });

  test("accepts query with topK", () => {
    expect(() => VectorRequestSchema.parse({ op: "query", text: "hello", topK: 10 })).not.toThrow();
  });

  test("rejects topK over 100", () => {
    expect(() => VectorRequestSchema.parse({ op: "query", text: "hello", topK: 101 })).toThrow();
  });

  test("accepts delete with single id", () => {
    expect(() => VectorRequestSchema.parse({ op: "delete", ids: "doc-1" })).not.toThrow();
  });

  test("accepts delete with array of ids", () => {
    expect(() => VectorRequestSchema.parse({ op: "delete", ids: ["a", "b", "c"] })).not.toThrow();
  });

  test("rejects delete with empty id string", () => {
    expect(() => VectorRequestSchema.parse({ op: "delete", ids: "" })).toThrow();
  });

  test("rejects delete with > 1000 ids", () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    expect(() => VectorRequestSchema.parse({ op: "delete", ids })).toThrow();
  });

  test("rejects unknown op", () => {
    expect(() => VectorRequestSchema.parse({ op: "scan", text: "x" })).toThrow();
  });

  test("rejects upsert with empty id", () => {
    expect(() => VectorRequestSchema.parse({ op: "upsert", id: "", text: "hello" })).toThrow();
  });

  test("rejects upsert with empty text", () => {
    expect(() => VectorRequestSchema.parse({ op: "upsert", id: "doc-1", text: "" })).toThrow();
  });

  test("rejects query with empty text", () => {
    expect(() => VectorRequestSchema.parse({ op: "query", text: "" })).toThrow();
  });
});
