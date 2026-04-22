// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import type { ToolSchema } from "../sdk/_internal-types.ts";
import { toVercelTools } from "./to-vercel-tools.ts";

const schemas: ToolSchema[] = [
  {
    name: "get_weather",
    description: "Look up the weather.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

describe("toVercelTools", () => {
  test("produces one Vercel AI SDK tool per schema, keyed by name", () => {
    const executeTool = vi.fn(async () => "sunny");
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "s1",
      messages: () => [],
    });
    expect(Object.keys(tools)).toEqual(["get_weather"]);
    expect(tools.get_weather).toMatchObject({
      description: "Look up the weather.",
    });
  });

  test("execute delegates to ctx.executeTool with (name, args, sessionId, messages)", async () => {
    const executeTool = vi.fn(async () => "rainy");
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "sess-42",
      messages: () => [{ role: "user", content: "?" }],
    });
    const result = await tools.get_weather?.execute?.(
      { city: "SF" },
      { toolCallId: "tc-1", messages: [] },
    );
    expect(executeTool).toHaveBeenCalledWith(
      "get_weather",
      { city: "SF" },
      "sess-42",
      [{ role: "user", content: "?" }],
      { toolCallId: "tc-1" },
    );
    expect(result).toBe("rainy");
  });

  test("execute passes through abort signal when provided", async () => {
    const controller = new AbortController();
    const executeTool = vi.fn(
      async (
        _n: string,
        _a: Readonly<Record<string, unknown>>,
        _s?: string,
        _m?: readonly unknown[],
        opts?: { signal?: AbortSignal },
      ) => {
        expect(opts?.signal).toBe(controller.signal);
        return "ok";
      },
    );
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "s",
      messages: () => [],
      signal: controller.signal,
    });
    await tools.get_weather?.execute?.({ city: "NY" }, { toolCallId: "tc-2", messages: [] });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  test("execute prefers options.abortSignal over ctx.signal", async () => {
    const ctxController = new AbortController();
    const callController = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const executeTool = vi.fn(
      async (
        _n: string,
        _a: Readonly<Record<string, unknown>>,
        _s?: string,
        _m?: readonly unknown[],
        opts?: { signal?: AbortSignal },
      ) => {
        receivedSignal = opts?.signal;
        return "ok";
      },
    );
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "s",
      messages: () => [],
      signal: ctxController.signal,
    });
    await tools.get_weather?.execute?.(
      { city: "NY" },
      { toolCallId: "tc-1", messages: [], abortSignal: callController.signal },
    );
    expect(receivedSignal).toBe(callController.signal);
  });

  test("execute falls back to ctx.signal when options.abortSignal is absent", async () => {
    const ctxController = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const executeTool = vi.fn(
      async (
        _n: string,
        _a: Readonly<Record<string, unknown>>,
        _s?: string,
        _m?: readonly unknown[],
        opts?: { signal?: AbortSignal },
      ) => {
        receivedSignal = opts?.signal;
        return "ok";
      },
    );
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "s",
      messages: () => [],
      signal: ctxController.signal,
    });
    await tools.get_weather?.execute?.({ city: "NY" }, { toolCallId: "tc-2", messages: [] });
    expect(receivedSignal).toBe(ctxController.signal);
  });

  test("execute propagates toolCallId from options", async () => {
    let receivedCallId: string | undefined;
    const executeTool = vi.fn(
      async (
        _n: string,
        _a: Readonly<Record<string, unknown>>,
        _s?: string,
        _m?: readonly unknown[],
        opts?: { toolCallId?: string },
      ) => {
        receivedCallId = opts?.toolCallId;
        return "ok";
      },
    );
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "s",
      messages: () => [],
    });
    await tools.get_weather?.execute?.({ city: "NY" }, { toolCallId: "tc-3", messages: [] });
    expect(receivedCallId).toBe("tc-3");
  });
});
