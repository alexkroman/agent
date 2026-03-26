// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { makeTool } from "./_test-utils.ts";
import type { ToolDef } from "./types.ts";
import { executeToolCall } from "./worker-entry.ts";

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
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Invalid arguments");
    expect(parsed.error).toContain("greet");
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
    ).toBe(JSON.stringify({ error: "boom" }));
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
    ).toBe(JSON.stringify({ error: "string error" }));
  });

  test("passes env to tool context", async () => {
    const tool = makeTool({ execute: (_args, ctx) => ctx.env.API_KEY ?? "missing" });
    expect(await run("test", {}, tool, { env: { API_KEY: "secret" } })).toBe("secret");
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

  test("handles async tool execution", async () => {
    const tool = makeTool({
      execute: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "async result";
      },
    });
    expect(await run("test", {}, tool)).toBe("async result");
  });

  test("sendUpdate calls onUpdate callback", async () => {
    const updates: unknown[] = [];
    const tool = makeTool({
      execute: (_args, ctx) => {
        ctx.sendUpdate({ preview: "loading" });
        ctx.sendUpdate({ preview: "ready" });
        return "done";
      },
    });
    await executeToolCall("test", {}, { tool, env: {}, onUpdate: (d) => updates.push(d) });
    expect(updates).toEqual([{ preview: "loading" }, { preview: "ready" }]);
  });

  test("sendUpdate is a no-op when onUpdate is not provided", async () => {
    const tool = makeTool({
      execute: (_args, ctx) => {
        ctx.sendUpdate({ data: "test" });
        return "ok";
      },
    });
    expect(await run("test", {}, tool)).toBe("ok");
  });

  test("times out tool that runs longer than TOOL_EXECUTION_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const tool = makeTool({
      execute: () =>
        new Promise(() => {
          /* never resolves */
        }),
    });
    const promise = run("slow", {}, tool);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;
    expect(result).toBe(JSON.stringify({ error: 'Tool "slow" timed out after 30000ms' }));
    vi.useRealTimers();
  });

  test("ctx.fetch uses provided fetch override", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const tool = makeTool({
      execute: async (_args, ctx) => typeof ctx.fetch,
    });
    const result = await executeToolCall("test", {}, { tool, env: {}, fetch: mockFetch });
    expect(result).toBe("function");
  });

  test("ctx.fetch defaults to globalThis.fetch when not provided", async () => {
    let capturedFetch: unknown;
    const tool = makeTool({
      execute: async (_args, ctx) => {
        capturedFetch = ctx.fetch;
        return "ok";
      },
    });
    await executeToolCall("test", {}, { tool, env: {} });
    expect(capturedFetch).toBe(globalThis.fetch);
  });
});
