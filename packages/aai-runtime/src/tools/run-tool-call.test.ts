// Copyright 2026 the AAI authors. MIT license.
import type { Message } from "@alexkroman1/aai";
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { FatalToolError } from "./error-policy.ts";
import { runToolCall, type ToolCallContext } from "./run-tool-call.ts";

const PARAMS = {
  type: "object" as const,
  properties: { count: { type: "number" as const } },
};

function context(executeTool: ExecuteTool, history: Message[] = []) {
  const recorded: Message[] = [];
  const ctx: ToolCallContext = {
    executeTool,
    sessionId: "s1",
    messages: () => history,
    parameters: (name) => (name === "count" ? PARAMS : undefined),
    recordToolResult: (m) => recorded.push(m),
  };
  return { ctx, recorded };
}

describe("runToolCall", () => {
  test("coerces, executes on a history snapshot, records, and returns both copies", async () => {
    const history: Message[] = [{ role: "user", content: "hi" }];
    const executeTool = vi.fn<ExecuteTool>(async (_n, _a, _s, messages) => {
      history.push({ role: "user", content: "late" });
      expect(messages).toHaveLength(1);
      return '{"ok":true}';
    });
    const { ctx, recorded } = context(executeTool, history);
    const settled = await runToolCall(
      { name: "count", args: { count: "3" }, toolCallId: "c1" },
      ctx,
    );
    expect(executeTool).toHaveBeenCalledWith("count", { count: 3 }, "s1", expect.any(Array), {
      toolCallId: "c1",
    });
    expect(settled).toMatchObject({ input: { count: 3 }, result: '{"ok":true}' });
    expect(recorded).toEqual([
      { role: "tool", content: '{"ok":true}', toolName: "count", toolCallId: "c1" },
    ]);
  });

  test("leaves arguments of a tool with no declared parameters alone", async () => {
    const executeTool = vi.fn<ExecuteTool>(async () => "ok");
    const { ctx } = context(executeTool);
    await runToolCall({ name: "other", args: { count: "3" } }, ctx);
    expect(executeTool.mock.calls[0]?.[1]).toEqual({ count: "3" });
  });

  test("starts executeTool synchronously when there is no hook", () => {
    const executeTool = vi.fn<ExecuteTool>(async () => "ok");
    const { ctx } = context(executeTool);
    void runToolCall({ name: "count", args: {} }, ctx);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  test("runs the hook with the coerced input before executing", async () => {
    const order: string[] = [];
    const executeTool = vi.fn<ExecuteTool>(async () => {
      order.push("execute");
      return "ok";
    });
    const { ctx } = context(executeTool);
    await runToolCall({ name: "count", args: { count: "2" } }, ctx, async (input) => {
      order.push(`hook:${JSON.stringify(input)}`);
    });
    expect(order).toEqual(['hook:{"count":2}', "execute"]);
  });

  test("rethrows a rejection untouched and records nothing", async () => {
    const fatal = new FatalToolError("count", new Error("boom"));
    const { ctx, recorded } = context(
      vi.fn<ExecuteTool>(async () => {
        throw fatal;
      }),
    );
    await expect(runToolCall({ name: "count", args: {} }, ctx)).rejects.toBe(fatal);
    expect(recorded).toEqual([]);
  });
});
