// Copyright 2025 the AAI authors. MIT license.
/**
 * Host-mode protocol schema tests.
 *
 * Covers the host-mode config handshake (`HostConfigMessageSchema`,
 * validated standalone, outside `ClientMessageSchema` — see
 * HOST_MODE_CONTRACT.md §5) and the `tool_result` inbound client message
 * (a `ClientMessageSchema` member).
 */
import { describe, expect, test } from "vitest";
import { MAX_TOOL_RESULT_CHARS } from "./constants.ts";
import { ClientMessageSchema, HostConfigMessageSchema, HostConfigSchema } from "./protocol.ts";

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

  test("rejects wrong type literal", () => {
    const result = HostConfigMessageSchema.safeParse({
      type: "not_config",
      host: { systemPrompt: "Hi", tools: [] },
    });
    expect(result.success).toBe(false);
  });
});

describe("ClientMessageSchema tool_result", () => {
  test("parses a tool_result message", () => {
    const result = ClientMessageSchema.safeParse({
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
    const result = ClientMessageSchema.safeParse({
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
    const result = ClientMessageSchema.safeParse({
      type: "tool_result",
      toolCallId: "",
      result: "72F and sunny",
    });
    expect(result.success).toBe(false);
  });

  test("rejects tool_result with result exceeding MAX_TOOL_RESULT_CHARS", () => {
    const result = ClientMessageSchema.safeParse({
      type: "tool_result",
      toolCallId: "tc-1",
      result: "x".repeat(MAX_TOOL_RESULT_CHARS + 1),
    });
    expect(result.success).toBe(false);
  });
});
