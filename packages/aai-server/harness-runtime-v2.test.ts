import { describe, expect, it, vi } from "vitest";
import {
  createDispatcher,
  type HookHandler,
  type RpcMessage,
  type ToolHandler,
} from "./harness-runtime-v2.ts";

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

  function makeDispatcher(
    tools: Record<string, ToolHandler> = {},
    hooks: Record<string, HookHandler> = {},
  ) {
    return createDispatcher({
      tools,
      hooks,
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

  it("dispatches hook to correct handler", async () => {
    const onConnect = vi.fn(async () => {
      /* noop */
    });
    const hooks: Record<string, HookHandler> = {
      onConnect: { default: onConnect },
    };
    const dispatch = makeDispatcher({}, hooks);

    const msg: RpcMessage = {
      type: "hook",
      hook: "onConnect",
      sessionId: "s1",
    };

    const result = await dispatch(msg);
    expect(result).toEqual({});
    expect(onConnect).toHaveBeenCalledOnce();
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { API_KEY: "test-key" },
        sessionId: "s1",
        kv: stubKv,
      }),
    );
  });

  it("dispatches onUserTranscript with text arg", async () => {
    const onUserTranscript = vi.fn(async () => {
      /* noop */
    });
    const hooks: Record<string, HookHandler> = {
      onUserTranscript: { default: onUserTranscript },
    };
    const dispatch = makeDispatcher({}, hooks);

    const msg: RpcMessage = {
      type: "hook",
      hook: "onUserTranscript",
      sessionId: "s1",
      text: "hello world",
    };

    const result = await dispatch(msg);
    expect(result).toEqual({});
    expect(onUserTranscript).toHaveBeenCalledOnce();
    expect(onUserTranscript).toHaveBeenCalledWith(
      "hello world",
      expect.objectContaining({
        env: { API_KEY: "test-key" },
        sessionId: "s1",
      }),
    );
  });

  it("dispatches onError with error arg", async () => {
    const onError = vi.fn(async () => {
      /* noop */
    });
    const hooks: Record<string, HookHandler> = {
      onError: { default: onError },
    };
    const dispatch = makeDispatcher({}, hooks);

    const msg: RpcMessage = {
      type: "hook",
      hook: "onError",
      sessionId: "s2",
      error: { message: "something broke" },
    };

    const result = await dispatch(msg);
    expect(result).toEqual({});
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      { message: "something broke" },
      expect.objectContaining({ sessionId: "s2" }),
    );
  });

  it("silently ignores unknown hooks", async () => {
    const dispatch = makeDispatcher();

    const msg: RpcMessage = {
      type: "hook",
      hook: "onSomeFutureHook",
      sessionId: "s1",
    };

    const result = await dispatch(msg);
    expect(result).toEqual({});
  });

  it("passes KV store to tool context", async () => {
    const execute = vi.fn(
      async (_args: unknown, ctx: { kv: { get: (k: string) => Promise<unknown> } }) => {
        const val = await ctx.kv.get("mykey");
        return { val };
      },
    );
    stubKv.get.mockResolvedValueOnce("stored-value");

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
