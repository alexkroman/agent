import { describe, expect, test } from "vitest";
import {
  AUDIO_FORMAT,
  AudioFrameSpec,
  buildReadyConfig,
  ClientEventSchema,
  ClientMessageSchema,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  fromWireMessages,
  HOOK_TIMEOUT_MS,
  KvRequestSchema,
  SessionErrorCodeSchema,
  TOOL_EXECUTION_TIMEOUT_MS,
  toWireMessages,
} from "./protocol.ts";

describe("protocol constants", () => {
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

  test("accepts valid list request", () => {
    const result = KvRequestSchema.safeParse({
      op: "list",
      prefix: "my-prefix",
    });
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

describe("buildReadyConfig", () => {
  test("builds config from sample rates", () => {
    const config = buildReadyConfig({ inputSampleRate: 16000, outputSampleRate: 24000 });
    expect(config).toEqual({
      audioFormat: AUDIO_FORMAT,
      sampleRate: 16000,
      ttsSampleRate: 24000,
    });
  });

  test("uses custom sample rates", () => {
    const config = buildReadyConfig({ inputSampleRate: 8000, outputSampleRate: 48000 });
    expect(config.sampleRate).toBe(8000);
    expect(config.ttsSampleRate).toBe(48000);
  });
});

describe("toWireMessages", () => {
  test("converts internal messages to wire format", () => {
    const internal = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" },
    ];
    const wire = toWireMessages(internal);
    expect(wire).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
  });

  test("handles empty array", () => {
    expect(toWireMessages([])).toEqual([]);
  });
});

describe("fromWireMessages", () => {
  test("converts wire messages to internal format", () => {
    const wire = [
      { role: "user" as const, text: "hello" },
      { role: "assistant" as const, text: "hi there" },
    ];
    const internal = fromWireMessages(wire);
    expect(internal).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  test("handles empty array", () => {
    expect(fromWireMessages([])).toEqual([]);
  });

  test("round-trips correctly", () => {
    const original = [
      { role: "user" as const, content: "test message" },
      { role: "assistant" as const, content: "response" },
    ];
    expect(fromWireMessages(toWireMessages(original))).toEqual(original);
  });
});
