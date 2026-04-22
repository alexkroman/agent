// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import type { ExecuteTool, ToolSchema } from "../sdk/_internal-types.ts";
import type { Message } from "../sdk/types.ts";
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

describe("toVercelTools — message snapshot isolation", () => {
  test("tool execute sees a snapshot, not a live ref to messages array", async () => {
    const messagesBox = { messages: [{ role: "user" as const, content: "first" }] };
    let observedInsideExecute: readonly Message[] | undefined;

    const executeTool: ExecuteTool = async (_name, _args, _sid, msgs) => {
      observedInsideExecute = msgs;
      // Mutate the original array; the snapshot we captured must be unaffected.
      messagesBox.messages.push({ role: "user", content: "second" });
      return "ok";
    };

    const tools = toVercelTools(
      [{ name: "t", description: "", parameters: { type: "object", properties: {} } }],
      {
        executeTool,
        sessionId: "s",
        messages: () => messagesBox.messages,
      },
    );

    const t = tools.t;
    if (!t?.execute) throw new Error("tool.execute missing");
    await t.execute({}, { toolCallId: "c1", messages: [] });

    // The caller-observable messages array has 2 entries after the push.
    expect(messagesBox.messages).toHaveLength(2);
    // But the snapshot the tool executed against was frozen at length 1.
    expect(observedInsideExecute).toHaveLength(1);
    expect(observedInsideExecute?.[0]).toMatchObject({ content: "first" });
  });
});
