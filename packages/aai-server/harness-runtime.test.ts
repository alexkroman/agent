import { describe, expect, test, vi } from "vitest";
import { createDispatcher, type HookHandler, type ToolHandler } from "./harness-runtime.ts";

describe("createDispatcher", () => {
  test("dispatches tool call to correct handler", async () => {
    const greetHandler = vi.fn(async (args) => ({ message: `hello ${args.name}` }));
    const tools: Record<string, ToolHandler> = {
      greet: {
        default: greetHandler,
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
    };

    const dispatch = createDispatcher({ tools, hooks: {} });
    const result = await dispatch({
      type: "tool",
      name: "greet",
      args: { name: "world" },
      sessionId: "s1",
      messages: [],
    });

    expect(greetHandler).toHaveBeenCalledWith(
      { name: "world" },
      expect.objectContaining({ sessionId: "s1" }),
    );
    expect(result).toEqual({ result: '{"message":"hello world"}' });
  });

  test("returns string results without double-serializing", async () => {
    const tools: Record<string, ToolHandler> = {
      echo: {
        default: vi.fn(async () => "plain string"),
      },
    };

    const dispatch = createDispatcher({ tools, hooks: {} });
    const result = await dispatch({
      type: "tool",
      name: "echo",
      args: {},
      sessionId: "s1",
      messages: [],
    });

    expect(result).toEqual({ result: "plain string" });
  });

  test("dispatches hook to correct handler", async () => {
    const onConnectHandler = vi.fn();
    const hooks: Record<string, HookHandler> = {
      onConnect: { default: onConnectHandler },
    };

    const dispatch = createDispatcher({ tools: {}, hooks });
    const result = await dispatch({
      type: "hook",
      hook: "onConnect",
      sessionId: "s1",
    });

    expect(onConnectHandler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }));
    expect(result).toEqual({});
  });

  test("dispatches onUserTranscript with text arg", async () => {
    const transcriptHandler = vi.fn();
    const hooks: Record<string, HookHandler> = {
      onUserTranscript: { default: transcriptHandler },
    };

    const dispatch = createDispatcher({ tools: {}, hooks });
    await dispatch({
      type: "hook",
      hook: "onUserTranscript",
      sessionId: "s1",
      text: "hello",
    });

    expect(transcriptHandler).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ sessionId: "s1" }),
    );
  });

  test("dispatches onError with error arg", async () => {
    const errorHandler = vi.fn();
    const hooks: Record<string, HookHandler> = {
      onError: { default: errorHandler },
    };

    const dispatch = createDispatcher({ tools: {}, hooks });
    await dispatch({
      type: "hook",
      hook: "onError",
      sessionId: "s1",
      error: { message: "boom" },
    });

    expect(errorHandler).toHaveBeenCalledWith(
      { message: "boom" },
      expect.objectContaining({ sessionId: "s1" }),
    );
  });

  test("returns error for unknown tool", async () => {
    const dispatch = createDispatcher({ tools: {}, hooks: {} });
    const result = await dispatch({
      type: "tool",
      name: "nonexistent",
      args: {},
      sessionId: "s1",
      messages: [],
    });
    expect(result).toEqual({
      result: expect.stringContaining("nonexistent"),
      error: true,
    });
  });

  test("ignores unknown hook gracefully", async () => {
    const dispatch = createDispatcher({ tools: {}, hooks: {} });
    const result = await dispatch({
      type: "hook",
      hook: "onSomethingWeird",
      sessionId: "s1",
    });
    expect(result).toEqual({});
  });

  test("ignores unknown message type", async () => {
    const dispatch = createDispatcher({ tools: {}, hooks: {} });
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown type
    const result = await dispatch({ type: "unknown" } as any);
    expect(result).toEqual({});
  });

  test("passes env and kv to tool context", async () => {
    let capturedCtx: unknown;
    const tools: Record<string, ToolHandler> = {
      inspect: {
        default: vi.fn(async (_args, ctx) => {
          capturedCtx = ctx;
          return "ok";
        }),
      },
    };

    const mockKv = {
      get: vi.fn(async () => null),
      set: vi.fn(),
      delete: vi.fn(),
    };

    const dispatch = createDispatcher({
      tools,
      hooks: {},
      env: { SECRET: "abc" },
      kv: mockKv,
    });

    await dispatch({
      type: "tool",
      name: "inspect",
      args: {},
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(capturedCtx).toEqual(
      expect.objectContaining({
        env: { SECRET: "abc" },
        kv: mockKv,
        sessionId: "s1",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
  });
});
