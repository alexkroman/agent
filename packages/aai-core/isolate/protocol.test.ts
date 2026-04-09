import { describe, expect, test } from "vitest";
import {
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  TOOL_EXECUTION_TIMEOUT_MS,
} from "./constants.ts";
import {
  AUDIO_FORMAT,
  buildReadyConfig,
  ClientEventSchema,
  ClientMessageSchema,
  KvRequestSchema,
  SessionErrorCodeSchema,
} from "./protocol.ts";

describe("protocol constants", () => {
  test("DEFAULT_STT_SAMPLE_RATE is 16000", () => {
    expect(DEFAULT_STT_SAMPLE_RATE).toBe(16_000);
  });

  test("DEFAULT_TTS_SAMPLE_RATE is 24000", () => {
    expect(DEFAULT_TTS_SAMPLE_RATE).toBe(24_000);
  });

  test('AUDIO_FORMAT is "pcm16"', () => {
    expect(AUDIO_FORMAT).toBe("pcm16");
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

  test("set accepts non-string values (objects, arrays, null)", () => {
    // The Kv interface accepts `value: unknown` — ensure the schema matches.
    for (const value of [{ nested: true }, [1, 2, 3], null, 42]) {
      const result = KvRequestSchema.safeParse({ op: "set", key: "k", value });
      expect(result.success, `set should accept value: ${JSON.stringify(value)}`).toBe(true);
    }
  });

  test("rejects empty key on get", () => {
    const result = KvRequestSchema.safeParse({
      op: "get",
      key: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("SessionErrorCodeSchema", () => {
  test("accepts valid codes", () => {
    for (const code of [
      "stt",
      "llm",
      "tts",
      "tool",
      "protocol",
      "connection",
      "audio",
      "internal",
    ]) {
      const result = SessionErrorCodeSchema.safeParse(code);
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid code", () => {
    const result = SessionErrorCodeSchema.safeParse("not_a_real_code");
    expect(result.success).toBe(false);
  });
});

describe("ClientEventSchema", () => {
  test("accepts speech_started", () => {
    const result = ClientEventSchema.safeParse({ type: "speech_started" });
    expect(result.success).toBe(true);
  });

  test("accepts user_transcript_delta with isFinal", () => {
    const result = ClientEventSchema.safeParse({
      type: "user_transcript_delta",
      text: "hello world",
      isFinal: true,
    });
    expect(result.success).toBe(true);
  });

  test("accepts error event", () => {
    const result = ClientEventSchema.safeParse({
      type: "error",
      code: "internal",
      message: "something went wrong",
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown type", () => {
    const result = ClientEventSchema.safeParse({
      type: "unknown_event_type",
    });
    expect(result.success).toBe(false);
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
      audioFormat: AUDIO_FORMAT,
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
