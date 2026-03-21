// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { ToolDef } from "./types.ts";
import { executeToolCall, TOOL_HANDLER_TIMEOUT } from "./worker_entry.ts";

function makeTool(overrides?: Partial<ToolDef>): ToolDef {
  return { description: "test tool", execute: () => "ok", ...overrides };
}

function run(
  name: string,
  args: Record<string, unknown>,
  tool: ToolDef,
  extra?: Record<string, unknown>,
) {
  return executeToolCall(name, args, { tool, env: {}, ...extra });
}

describe("executeToolCall", () => {
  test("returns string result from tool", async () => {
    expect(await run("test", {}, makeTool({ execute: () => "hello" }))).toBe("hello");
  });

  test("serializes non-string result as JSON", async () => {
    expect(await run("test", {}, makeTool({ execute: () => ({ count: 42 }) }))).toBe(
      '{"count":42}',
    );
  });

  test("returns 'null' for null/undefined result", async () => {
    expect(await run("test", {}, makeTool({ execute: () => null }))).toBe("null");
  });

  test("validates args against parameter schema", async () => {
    const tool = makeTool({
      parameters: z.object({ name: z.string() }),
      execute: (args) => `hi ${(args as { name: string }).name}`,
    });
    expect(await run("greet", { name: "alice" }, tool)).toBe("hi alice");
  });

  test("returns error for invalid args", async () => {
    const tool = makeTool({ parameters: z.object({ name: z.string() }), execute: () => "ok" });
    const result = await run("greet", { name: 123 }, tool);
    expect(result.startsWith("Error: Invalid arguments")).toBe(true);
    expect(result.includes("greet")).toBe(true);
  });

  test("returns error when tool throws", async () => {
    expect(
      await run(
        "fail",
        {},
        makeTool({
          execute: () => {
            throw new Error("boom");
          },
        }),
      ),
    ).toBe("Error: boom");
  });

  test("returns error string when tool throws", async () => {
    expect(
      await run(
        "fail",
        {},
        makeTool({
          execute: () => {
            throw new Error("string error");
          },
        }),
      ),
    ).toBe("Error: string error");
  });

  test("passes env to tool context", async () => {
    const tool = makeTool({ execute: (_args, ctx) => ctx.env.API_KEY ?? "missing" });
    expect(await run("test", {}, tool, { env: { API_KEY: "secret" } })).toBe("secret");
  });

  test("passes sessionId to tool context", async () => {
    const tool = makeTool({ execute: (_args, ctx) => ctx.sessionId });
    expect(await run("test", {}, tool, { sessionId: "sess-123" })).toBe("sess-123");
  });

  test("defaults sessionId to empty string", async () => {
    const tool = makeTool({ execute: (_args, ctx) => ctx.sessionId });
    expect(await run("test", {}, tool)).toBe("");
  });

  test("passes messages to tool context", async () => {
    const tool = makeTool({ execute: (_args, ctx) => String(ctx.messages.length) });
    expect(await run("test", {}, tool, { messages: [{ role: "user", content: "hi" }] })).toBe("1");
  });

  test("kv throws when not provided", async () => {
    const tool = makeTool({
      execute: (_args, ctx) => {
        try {
          void ctx.kv;
          return "no error";
        } catch (e) {
          return (e as Error).message;
        }
      },
    });
    expect(await run("test", {}, tool)).toBe("KV not available");
  });

  test("provides abortSignal in context", async () => {
    const tool = makeTool({
      execute: (_args, ctx) => String(ctx.abortSignal instanceof AbortSignal),
    });
    expect(await run("test", {}, tool)).toBe("true");
  });

  test("handles async tool execution", async () => {
    const tool = makeTool({
      execute: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "async result";
      },
    });
    expect(await run("test", {}, tool)).toBe("async result");
  });

  test("TOOL_HANDLER_TIMEOUT is 30 seconds", () => {
    expect(TOOL_HANDLER_TIMEOUT).toBe(30_000);
  });
});
