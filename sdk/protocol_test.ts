import { describe, expect, test } from "vitest";
import {
  AUDIO_FORMAT,
  AudioFrameSpec,
  ClientEventSchema,
  ClientMessageSchema,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  HOOK_TIMEOUT_MS,
  KvRequestBaseSchema,
  PROTOCOL_VERSION,
  SessionErrorCodeSchema,
  TOOL_EXECUTION_TIMEOUT_MS,
} from "./protocol.ts";

describe("protocol constants", () => {
  test("PROTOCOL_VERSION is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  test("DEFAULT_STT_SAMPLE_RATE is 16000", () => {
    expect(DEFAULT_STT_SAMPLE_RATE).toBe(16000);
  });

  test("DEFAULT_TTS_SAMPLE_RATE is 24000", () => {
    expect(DEFAULT_TTS_SAMPLE_RATE).toBe(24000);
  });

  test('AUDIO_FORMAT is "pcm16"', () => {
    expect(AUDIO_FORMAT).toBe("pcm16");
  });

  test("AudioFrameSpec has correct values", () => {
    expect(AudioFrameSpec.bitsPerSample).toBe(16);
    expect(AudioFrameSpec.channels).toBe(1);
    expect(AudioFrameSpec.bytesPerSample).toBe(2);
  });

  test("HOOK_TIMEOUT_MS is 5000", () => {
    expect(HOOK_TIMEOUT_MS).toBe(5000);
  });

  test("TOOL_EXECUTION_TIMEOUT_MS is 30000", () => {
    expect(TOOL_EXECUTION_TIMEOUT_MS).toBe(30000);
  });
});

describe("KvRequestBaseSchema", () => {
  test("accepts valid get request", () => {
    const result = KvRequestBaseSchema.safeParse({
      op: "get",
      key: "my-key",
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid set request with ttl", () => {
    const result = KvRequestBaseSchema.safeParse({
      op: "set",
      key: "my-key",
      value: "my-value",
      ttl: 3600,
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid list request", () => {
    const result = KvRequestBaseSchema.safeParse({
      op: "list",
      prefix: "my-prefix",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty key on get", () => {
    const result = KvRequestBaseSchema.safeParse({
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

  test("accepts transcript with isFinal", () => {
    const result = ClientEventSchema.safeParse({
      type: "transcript",
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
      messages: [{ role: "user", text: "hello" }],
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
