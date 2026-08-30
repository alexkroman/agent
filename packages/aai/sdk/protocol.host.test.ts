// Copyright 2025 the AAI authors. MIT license.
/**
 * Host-mode protocol schema tests.
 *
 * Covers the host-mode config handshake (`HostConfigMessageSchema`,
 * validated standalone, outside `SessionCommandSchema` — see
 * HOST_MODE_CONTRACT.md §5) and the `tool_result` inbound client message
 * (a `SessionCommandSchema` member).
 */
import { describe, expect, test } from "vitest";
import {
  MAX_AUDIO_SAMPLE_RATE,
  MAX_TOOL_RESULT_CHARS,
  TOOL_RESULT_TRUNCATION_MARKER,
} from "./constants.ts";
import { HostConfigMessageSchema, HostConfigSchema, SessionCommandSchema } from "./protocol.ts";

describe("HostConfigSchema", () => {
  test("parses systemPrompt + tools and exposes them", () => {
    const result = HostConfigSchema.safeParse({
      systemPrompt: "You are a helpful assistant.",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Look up the weather",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systemPrompt).toBe("You are a helpful assistant.");
      expect(result.data.tools).toHaveLength(1);
      expect(result.data.tools[0]?.name).toBe("get_weather");
    }
  });

  test("accepts optional greeting", () => {
    const result = HostConfigSchema.safeParse({
      systemPrompt: "Hi",
      greeting: "Hello there!",
      tools: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.greeting).toBe("Hello there!");
    }
  });

  test("rejects empty systemPrompt", () => {
    const result = HostConfigSchema.safeParse({ systemPrompt: "", tools: [] });
    expect(result.success).toBe(false);
  });

  test("rejects missing tools", () => {
    const result = HostConfigSchema.safeParse({ systemPrompt: "Hi" });
    expect(result.success).toBe(false);
  });

  test("accepts optional credentials", () => {
    const result = HostConfigSchema.safeParse({
      systemPrompt: "Hi",
      tools: [],
      credentials: { ASSEMBLYAI_API_KEY: "sk-test" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.credentials).toEqual({ ASSEMBLYAI_API_KEY: "sk-test" });
    }
  });

  test("rejects an empty credential value", () => {
    // An empty key reaches the provider resolver as a present-but-useless
    // credential, which fails as "invalid key" rather than "you sent none".
    const result = HostConfigSchema.safeParse({
      systemPrompt: "Hi",
      tools: [],
      credentials: { ASSEMBLYAI_API_KEY: "" },
    });
    expect(result.success).toBe(false);
  });

  // Which NAMES are allowed is not a schema concern — the allowlist lives in
  // `unknownCredentialName` (host-mode.ts), where the rejection can name the
  // offending key instead of collapsing into a generic parse failure.
  test("accepts an unlisted credential name at the schema layer", () => {
    const result = HostConfigSchema.safeParse({
      systemPrompt: "Hi",
      tools: [],
      credentials: { DATABASE_URL: "postgres://x" },
    });
    expect(result.success).toBe(true);
  });
});

describe("HostConfigMessageSchema", () => {
  test("parses a config message with host block", () => {
    const result = HostConfigMessageSchema.safeParse({
      type: "config",
      host: {
        systemPrompt: "You are a helpful assistant.",
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Look up the weather",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host.systemPrompt).toBe("You are a helpful assistant.");
      expect(result.data.host.tools).toHaveLength(1);
    }
  });

  test("rejects config message with empty host.systemPrompt", () => {
    const result = HostConfigMessageSchema.safeParse({
      type: "config",
      host: { systemPrompt: "", tools: [] },
    });
    expect(result.success).toBe(false);
  });

  test.each(["sampleRate", "ttsSampleRate"] as const)(
    "rejects a %s above MAX_AUDIO_SAMPLE_RATE",
    (field) => {
      // These two feed `session.configured`, whose own schema bounds them at
      // MAX_AUDIO_SAMPLE_RATE precisely because "an unbounded server value
      // would be an allocation-size lever against the client". Unbounded HERE,
      // the server accepted a rate it would then EMIT and reject: measured
      // against `aai dev` with host mode on, `sampleRate: 2 ** 31` was accepted
      // and echoed back in `session.configured` — a frame that fails the
      // protocol's own outbound parse.
      const result = HostConfigMessageSchema.safeParse({
        type: "config",
        host: { systemPrompt: "Hi", tools: [] },
        [field]: MAX_AUDIO_SAMPLE_RATE + 1,
      });
      expect(result.success).toBe(false);
    },
  );

  test.each(["sampleRate", "ttsSampleRate"] as const)("accepts a %s at the cap", (field) => {
    // A bound, not a narrowing: every rate a real device produces is far
    // below this, and the cap itself has to stay reachable.
    const result = HostConfigMessageSchema.safeParse({
      type: "config",
      host: { systemPrompt: "Hi", tools: [] },
      [field]: MAX_AUDIO_SAMPLE_RATE,
    });
    expect(result.success).toBe(true);
  });

  test("rejects wrong type literal", () => {
    const result = HostConfigMessageSchema.safeParse({
      type: "not_config",
      host: { systemPrompt: "Hi", tools: [] },
    });
    expect(result.success).toBe(false);
  });

  test("accepts the pcm16 audio negotiation fields", () => {
    const result = HostConfigMessageSchema.safeParse({
      type: "config",
      host: { systemPrompt: "Hi", tools: [] },
      audioFormat: "pcm16",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.audioFormat).toBe("pcm16");
      expect(result.data.sampleRate).toBe(16_000);
      expect(result.data.ttsSampleRate).toBe(24_000);
    }
  });

  test("rejects an audioFormat other than pcm16", () => {
    const result = HostConfigMessageSchema.safeParse({
      type: "config",
      host: { systemPrompt: "Hi", tools: [] },
      audioFormat: "wav",
    });
    expect(result.success).toBe(false);
  });
});

describe("SessionCommandSchema tool_result", () => {
  test("parses a tool_result message", () => {
    const result = SessionCommandSchema.safeParse({
      type: "tool_result",
      toolCallId: "tc-1",
      result: "72F and sunny",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "tool_result") {
      expect(result.data.toolCallId).toBe("tc-1");
      expect(result.data.result).toBe("72F and sunny");
    }
  });

  test("parses a tool_result message with error", () => {
    const result = SessionCommandSchema.safeParse({
      type: "tool_result",
      toolCallId: "tc-1",
      result: "",
      error: "tool execution failed",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "tool_result") {
      expect(result.data.error).toBe("tool execution failed");
    }
  });

  test("rejects tool_result with empty toolCallId", () => {
    const result = SessionCommandSchema.safeParse({
      type: "tool_result",
      toolCallId: "",
      result: "72F and sunny",
    });
    expect(result.success).toBe(false);
  });

  test("truncates an oversized tool_result instead of rejecting it", () => {
    // Rejecting it meant the frame was dropped, so the relay call it answered
    // never settled and hung to DEFAULT_RELAY_TOOL_TIMEOUT_MS — a stuck tool
    // instead of data that didn't fit.
    const result = SessionCommandSchema.safeParse({
      type: "tool_result",
      toolCallId: "tc-1",
      result: "x".repeat(MAX_TOOL_RESULT_CHARS + 5000),
    });
    expect(result.success).toBe(true);
    const parsed = result.success && result.data.type === "tool_result" ? result.data.result : "";
    expect(parsed.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    // Marked, so a model reading it knows the record is incomplete rather than
    // counting a partial list as though it were the whole one.
    expect(parsed).toContain(TOOL_RESULT_TRUNCATION_MARKER);
  });
});
