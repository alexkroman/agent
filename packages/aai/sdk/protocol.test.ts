import fc from "fast-check";
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  TOOL_EXECUTION_TIMEOUT_MS,
} from "./constants.ts";
import type { SessionEvent } from "./protocol.ts";
import {
  buildReadyConfig,
  EVENT_ID_PREFIX,
  lenientParse,
  SESSION_COMMAND_TYPES,
  SessionCommandSchema,
  SessionErrorCodeSchema,
  SessionEventSchema,
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

describe("SessionEventSchema", () => {
  test("accepts speech.started", () => {
    expect({ type: "speech.started" }).toBeValidSessionEvent();
  });

  test("accepts user-transcript.committed", () => {
    expect({ type: "user-transcript.committed", text: "hello world" }).toBeValidSessionEvent();
  });

  test("accepts error event", () => {
    expect({
      type: "error.reported",
      code: "internal",
      message: "something went wrong",
      fatal: true,
    }).toBeValidSessionEvent();
  });

  test("rejects unknown type", () => {
    expect({ type: "unknown_event_type" }).not.toBeValidSessionEvent();
  });
});

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
        const result = lenientParse(SessionEventSchema, input);
        expect(result).toHaveProperty("ok");
      }),
    );
  });

  test("valid session events round-trip through parse", () => {
    // The envelope is generated too, rather than fixed: it is REQUIRED now, so a
    // generator that always supplied a good one would never exercise the field
    // that every reader keys on.
    const metaArb = fc.record({
      id: fc.string({ minLength: 1 }).map((tail) => `${EVENT_ID_PREFIX}${tail}`),
      at: fc.nat(),
    });
    const bodyArb = fc.oneof(
      fc.constant({ type: "speech.started" as const }),
      fc.record({ type: fc.constant("user-transcript.committed" as const), text: fc.string() }),
      fc.record({
        type: fc.constant("error.reported" as const),
        code: fc.constantFrom(...ERROR_CODES),
        message: fc.string(),
        fatal: fc.boolean(),
      }),
    );
    fc.assert(
      fc.property(bodyArb, metaArb, (body, meta) => {
        const result = lenientParse(SessionEventSchema, { ...body, meta });
        expect(result.ok).toBe(true);
      }),
    );
  });

  test("objects without type field are malformed", () => {
    const noTypeArb = fc.object().filter((obj) => !("type" in obj));

    fc.assert(
      fc.property(noTypeArb, (obj) => {
        const result = lenientParse(SessionEventSchema, obj);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.malformed).toBe(true);
        }
      }),
    );
  });

  test("a known type that fails validation is malformed (not an ignorable unknown type)", () => {
    // A tool_result missing toolCallId is a *known* type that failed strict
    // validation — with SESSION_COMMAND_TYPES it must report malformed:true so
    // the host warns, not silently swallow it as a forward-compat unknown type.
    const result = lenientParse(
      SessionCommandSchema,
      { type: "tool_result", result: "x" },
      SESSION_COMMAND_TYPES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.malformed).toBe(true);
  });

  test("an unknown type is not malformed (safe to ignore across versions)", () => {
    const result = lenientParse(
      SessionCommandSchema,
      { type: "from_a_newer_client" },
      SESSION_COMMAND_TYPES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.malformed).toBe(false);
  });
});

describe("protocol type contracts", () => {
  test("SessionEvent narrows on user-transcript.committed", () => {
    type UserTranscript = Extract<SessionEvent, { type: "user-transcript.committed" }>;
    expectTypeOf<UserTranscript>().toHaveProperty("text");
    expectTypeOf<UserTranscript["text"]>().toBeString();
  });

  test("SessionEvent narrows on tool.called", () => {
    type ToolCall = Extract<SessionEvent, { type: "tool.called" }>;
    expectTypeOf<ToolCall>().toHaveProperty("toolCallId");
    expectTypeOf<ToolCall>().toHaveProperty("toolName");
    expectTypeOf<ToolCall>().toHaveProperty("args");
  });

  test("SessionEvent narrows on error.reported", () => {
    type ErrorEvent = Extract<SessionEvent, { type: "error.reported" }>;
    expectTypeOf<ErrorEvent>().toHaveProperty("code");
    expectTypeOf<ErrorEvent>().toHaveProperty("message");
  });

  test("SessionEvent has type property on all variants", () => {
    expectTypeOf<SessionEvent>().toHaveProperty("type");
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
