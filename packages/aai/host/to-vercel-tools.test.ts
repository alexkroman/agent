// Copyright 2025 the AAI authors. MIT license.
import type { Tool, ToolExecutionOptions } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { ExecuteTool, ExecuteToolOptions, ToolSchema } from "../sdk/_internal-types.ts";
import type { Message } from "../sdk/types.ts";
import { toVercelTools } from "./to-vercel-tools.ts";

const schemas: ToolSchema[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Look up the weather.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

function runTool(
  tool: Tool | undefined,
  args: Readonly<Record<string, unknown>>,
  options: Omit<ToolExecutionOptions<unknown>, "context">,
): Promise<unknown> {
  if (!tool?.execute) throw new Error("tool.execute missing");
  return tool.execute(args, { ...options, context: undefined });
}

describe("toVercelTools", () => {
  test("produces one Vercel AI SDK tool per schema, keyed by name", () => {
    const executeTool = vi.fn(async () => "sunny");
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "s1",
      messages: () => [],
    });
    expect(Object.keys(tools)).toEqual(["get_weather"]);
    expect(tools.get_weather).toMatchObject({ description: "Look up the weather." });
  });

  test("execute delegates to ctx.executeTool with (name, args, sessionId, messages)", async () => {
    const executeTool = vi.fn(async () => "rainy");
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "sess-42",
      messages: () => [{ role: "user", content: "?" }],
    });
    const result = await runTool(
      tools.get_weather,
      { city: "SF" },
      {
        toolCallId: "tc-1",
        messages: [],
      },
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
    let received: ExecuteToolOptions | undefined;
    const executeTool: ExecuteTool = async (_n, _a, _s, _m, opts) => {
      received = opts;
      return "ok";
    };
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "s",
      messages: () => [],
      signal: controller.signal,
    });
    await runTool(tools.get_weather, { city: "NY" }, { toolCallId: "tc-2", messages: [] });
    expect(received?.signal).toBe(controller.signal);
  });

  test("execute prefers options.abortSignal over ctx.signal", async () => {
    const ctxController = new AbortController();
    const callController = new AbortController();
    let received: ExecuteToolOptions | undefined;
    const executeTool: ExecuteTool = async (_n, _a, _s, _m, opts) => {
      received = opts;
      return "ok";
    };
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "s",
      messages: () => [],
      signal: ctxController.signal,
    });
    await runTool(
      tools.get_weather,
      { city: "NY" },
      {
        toolCallId: "tc-1",
        messages: [],
        abortSignal: callController.signal,
      },
    );
    expect(received?.signal).toBe(callController.signal);
  });

  test("execute falls back to ctx.signal when options.abortSignal is absent", async () => {
    const ctxController = new AbortController();
    let received: ExecuteToolOptions | undefined;
    const executeTool: ExecuteTool = async (_n, _a, _s, _m, opts) => {
      received = opts;
      return "ok";
    };
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "s",
      messages: () => [],
      signal: ctxController.signal,
    });
    await runTool(tools.get_weather, { city: "NY" }, { toolCallId: "tc-2", messages: [] });
    expect(received?.signal).toBe(ctxController.signal);
  });

  test("execute propagates toolCallId from options", async () => {
    let received: ExecuteToolOptions | undefined;
    const executeTool: ExecuteTool = async (_n, _a, _s, _m, opts) => {
      received = opts;
      return "ok";
    };
    const tools = toVercelTools(schemas, {
      executeTool,
      sessionId: "s",
      messages: () => [],
    });
    await runTool(tools.get_weather, { city: "NY" }, { toolCallId: "tc-3", messages: [] });
    expect(received?.toolCallId).toBe("tc-3");
  });
});

describe("toVercelTools — argument type coercion", () => {
  test("stringified scalars are coerced to the schema's declared types before executeTool", async () => {
    const executeTool = vi.fn(async () => "ok");
    const tools = toVercelTools(
      [
        {
          type: "function",
          name: "search_apartments",
          description: "Search.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string" },
              max_price: { type: "number" },
              pets_allowed: { type: "boolean" },
            },
          },
        },
      ],
      { executeTool, sessionId: "s", messages: () => [] },
    );
    await runTool(
      tools.search_apartments,
      { city: "Dallas", max_price: "1500", pets_allowed: "true" },
      { toolCallId: "tc-1", messages: [] },
    );
    expect(executeTool).toHaveBeenCalledWith(
      "search_apartments",
      { city: "Dallas", max_price: 1500, pets_allowed: true },
      "s",
      [],
      { toolCallId: "tc-1" },
    );
  });
});

describe("toVercelTools — message snapshot isolation", () => {
  test("tool execute sees a snapshot, not a live ref to messages array", async () => {
    const messagesBox = { messages: [{ role: "user" as const, content: "first" }] };
    let observedInsideExecute: readonly Message[] | undefined;

    const executeTool: ExecuteTool = async (_name, _args, _sid, msgs) => {
      observedInsideExecute = msgs;
      messagesBox.messages.push({ role: "user", content: "second" });
      return "ok";
    };

    const tools = toVercelTools(
      [
        {
          type: "function",
          name: "t",
          description: "",
          parameters: { type: "object", properties: {} },
        },
      ],
      {
        executeTool,
        sessionId: "s",
        messages: () => messagesBox.messages,
      },
    );

    await runTool(tools.t, {}, { toolCallId: "c1", messages: [] });

    expect(messagesBox.messages).toHaveLength(2);
    expect(observedInsideExecute).toHaveLength(1);
    expect(observedInsideExecute?.[0]).toMatchObject({ content: "first" });
  });
});
