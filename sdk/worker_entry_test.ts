// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { ToolDef } from "./types.ts";
import { executeToolCall, TOOL_HANDLER_TIMEOUT } from "./worker_entry.ts";

function makeTool(overrides?: Partial<ToolDef>): ToolDef {
  return {
    description: "test tool",
    execute: () => "ok",
    ...overrides,
  };
}

describe("executeToolCall", () => {
  test("returns string result from tool", async () => {
    const tool = makeTool({ execute: () => "hello" });
    const result = await executeToolCall(
      "test",
      {},
      {
        tool,
        env: {},
      },
    );
    expect(result).toBe("hello");
  });

  test("serializes non-string result as JSON", async () => {
    const tool = makeTool({ execute: () => ({ count: 42 }) });
    const result = await executeToolCall(
      "test",
      {},
      {
        tool,
        env: {},
      },
    );
    expect(result).toBe('{"count":42}');
  });

  test("returns 'null' for null/undefined result", async () => {
    const tool = makeTool({ execute: () => null });
    const result = await executeToolCall(
      "test",
      {},
      {
        tool,
        env: {},
      },
    );
    expect(result).toBe("null");
  });

  test("validates args against parameter schema", async () => {
    const tool = makeTool({
      parameters: z.object({ name: z.string() }),
      execute: (args) => `hi ${(args as { name: string }).name}`,
    });
    const result = await executeToolCall(
      "greet",
      { name: "alice" },
      {
        tool,
        env: {},
      },
    );
    expect(result).toBe("hi alice");
  });

  test("returns error for invalid args", async () => {
    const tool = makeTool({
      parameters: z.object({ name: z.string() }),
      execute: () => "ok",
    });
    const result = await executeToolCall(
      "greet",
      { name: 123 },
      {
        tool,
        env: {},
      },
    );
    expect(result.startsWith("Error: Invalid arguments")).toBe(true);
    expect(result.includes("greet")).toBe(true);
  });

  test("returns error when tool throws", async () => {
    const tool = makeTool({
      execute: () => {
        throw new Error("boom");
      },
    });
    const result = await executeToolCall(
      "fail",
      {},
      {
        tool,
        env: {},
      },
    );
    expect(result).toBe("Error: boom");
  });

  test("returns error for non-Error throw", async () => {
    const tool = makeTool({
      execute: () => {
        throw "string error";
      },
    });
    const result = await executeToolCall(
      "fail",
      {},
      {
        tool,
        env: {},
      },
    );
    expect(result).toBe("Error: string error");
  });

  test("passes env to tool context", async () => {
    const tool = makeTool({
      execute: (_args, ctx) => ctx.env.API_KEY ?? "missing",
    });
    const result = await executeToolCall(
      "test",
      {},
      {
        tool,
        env: { API_KEY: "secret" },
      },
    );
    expect(result).toBe("secret");
  });

  test("passes sessionId to tool context", async () => {
    const tool = makeTool({
      execute: (_args, ctx) => ctx.sessionId,
    });
    const result = await executeToolCall(
      "test",
      {},
      {
        tool,
        env: {},
        sessionId: "sess-123",
      },
    );
    expect(result).toBe("sess-123");
  });

  test("defaults sessionId to empty string", async () => {
    const tool = makeTool({
      execute: (_args, ctx) => ctx.sessionId,
    });
    const result = await executeToolCall(
      "test",
      {},
      {
        tool,
        env: {},
      },
    );
    expect(result).toBe("");
  });

  test("passes messages to tool context", async () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const tool = makeTool({
      execute: (_args, ctx) => String(ctx.messages.length),
    });
    const result = await executeToolCall(
      "test",
      {},
      {
        tool,
        env: {},
        messages,
      },
    );
    expect(result).toBe("1");
  });

  test("kv throws when not provided", async () => {
    const tool = makeTool({
      execute: (_args, ctx) => {
        // accessing ctx.kv should throw
        try {
          void ctx.kv;
          return "no error";
        } catch (e) {
          return (e as Error).message;
        }
      },
    });
    const result = await executeToolCall(
      "test",
      {},
      {
        tool,
        env: {},
      },
    );
    expect(result).toBe("KV not available");
  });

  test("provides abortSignal in context", async () => {
    const tool = makeTool({
      execute: (_args, ctx) => String(ctx.abortSignal instanceof AbortSignal),
    });
    const result = await executeToolCall(
      "test",
      {},
      {
        tool,
        env: {},
      },
    );
    expect(result).toBe("true");
  });

  test("handles async tool execution", async () => {
    const tool = makeTool({
      execute: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "async result";
      },
    });
    const result = await executeToolCall(
      "test",
      {},
      {
        tool,
        env: {},
      },
    );
    expect(result).toBe("async result");
  });

  test("TOOL_HANDLER_TIMEOUT is 30 seconds", () => {
    expect(TOOL_HANDLER_TIMEOUT).toBe(30_000);
  });
});
