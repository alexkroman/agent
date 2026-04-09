import { describe, expect, it, vi } from "vitest";
import { createDispatcher, type RpcMessage, type ToolHandler } from "./harness-runtime-v2.ts";

describe("createDispatcher", () => {
  const stubKv = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {
      /* noop */
    }),
    delete: vi.fn(async () => {
      /* noop */
    }),
  };

  function makeDispatcher(tools: Record<string, ToolHandler> = {}) {
    return createDispatcher({
      tools,
      env: { API_KEY: "test-key" },
      kv: stubKv,
    });
  }

  it("dispatches tool call to correct handler", async () => {
    const execute = vi.fn(async (args: unknown) => ({
      greeting: `Hello, ${(args as { name: string }).name}!`,
    }));
    const tools: Record<string, ToolHandler> = {
      greet: { default: execute, description: "Greet someone" },
    };
    const dispatch = makeDispatcher(tools);

    const msg: RpcMessage = {
      type: "tool",
      name: "greet",
      args: { name: "Alice" },
      sessionId: "s1",
      messages: [{ role: "user", content: "Hi" }],
    };

    const result = await dispatch(msg);
    expect(result).toEqual({ result: JSON.stringify({ greeting: "Hello, Alice!" }) });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { name: "Alice" },
      expect.objectContaining({
        env: { API_KEY: "test-key" },
        sessionId: "s1",
        kv: stubKv,
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
  });

  it("returns error for unknown tool", async () => {
    const dispatch = makeDispatcher();

    const msg: RpcMessage = {
      type: "tool",
      name: "nonexistent",
      args: {},
      sessionId: "s1",
      messages: [],
    };

    const result = await dispatch(msg);
    expect(result).toEqual({
      result: JSON.stringify({ error: "Unknown tool: nonexistent" }),
      error: true,
    });
  });

  it("passes KV store to tool context", async () => {
    const execute = vi.fn(
      async (_args: unknown, ctx: { kv: { get: (k: string) => Promise<unknown> } }) => {
        const val = await ctx.kv.get("mykey");
        return { val };
      },
    );
    stubKv.get.mockResolvedValueOnce("stored-value" as unknown as null);

    const tools: Record<string, ToolHandler> = {
      lookup: { default: execute },
    };
    const dispatch = makeDispatcher(tools);

    const msg: RpcMessage = {
      type: "tool",
      name: "lookup",
      args: {},
      sessionId: "s1",
      messages: [],
    };

    const result = await dispatch(msg);
    expect(result).toEqual({ result: JSON.stringify({ val: "stored-value" }) });
    expect(stubKv.get).toHaveBeenCalledWith("mykey");
  });

  it("stringifies non-string tool results", async () => {
    const execute = vi.fn(async () => 42);
    const tools: Record<string, ToolHandler> = {
      count: { default: execute },
    };
    const dispatch = makeDispatcher(tools);

    const msg: RpcMessage = {
      type: "tool",
      name: "count",
      args: {},
      sessionId: "s1",
      messages: [],
    };

    const result = await dispatch(msg);
    expect(result).toEqual({ result: "42" });
  });
});
