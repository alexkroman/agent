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
  CLIENT_MESSAGE_TYPES,
  ClientEventSchema,
  ClientMessageSchema,
  lenientParse,
  SessionErrorCodeSchema,
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

  test("a known type that fails validation is malformed (not an ignorable unknown type)", () => {
    // A tool_result missing toolCallId is a *known* type that failed strict
    // validation — with CLIENT_MESSAGE_TYPES it must report malformed:true so
    // the host warns, not silently swallow it as a forward-compat unknown type.
    const result = lenientParse(
      ClientMessageSchema,
      { type: "tool_result", result: "x" },
      CLIENT_MESSAGE_TYPES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.malformed).toBe(true);
  });

  test("an unknown type is not malformed (safe to ignore across versions)", () => {
    const result = lenientParse(
      ClientMessageSchema,
      { type: "from_a_newer_client" },
      CLIENT_MESSAGE_TYPES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.malformed).toBe(false);
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
