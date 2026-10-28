// Copyright 2026 the AAI authors. MIT license.
import type { Message } from "@alexkroman1/aai";
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import { withInstruction } from "@alexkroman1/aai/utils";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, test, vi } from "vitest";
import { FatalToolError } from "./error-policy.ts";
import { FailedCallMemo } from "./failed-call-memo.ts";
import { FormatMirror } from "./format-mirror.ts";
import { TOOL_INSTRUCTION_LABEL } from "./result-instruction.ts";
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
    formatMirror: new FormatMirror(),
  };
  return { ctx, recorded };
}

describe("runToolCall", () => {
  test("a withInstruction result is recorded stripped, and the model's copy carries the sentence", async () => {
    const raw = JSON.stringify(withInstruction({ steps: ["a"] }, "Read it back."));
    const { ctx, recorded } = context(vi.fn<ExecuteTool>(async () => raw));
    const settled = await runToolCall({ name: "plan", args: {}, toolCallId: "c9" }, ctx);
    expect(settled.result).toBe('{"steps":["a"]}');
    expect(settled.instruction).toBe("Read it back.");
    expect(settled.forModel).toBe(`{"steps":["a"]}\n\n${TOOL_INSTRUCTION_LABEL} Read it back.`);
    // What a later tool reads, and what the client's frame is built from: the
    // tool's own data, with the reserved key gone.
    expect(recorded).toEqual([
      { role: "tool", content: '{"steps":["a"]}', toolName: "plan", toolCallId: "c9" },
    ]);
  });

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

describe("runToolCall with a FailedCallMemo", () => {
  test("an identical failed call never reaches executeTool or the hook, and is recorded", async () => {
    const executeTool = vi.fn<ExecuteTool>(async () => "Error: User not found");
    const { ctx, recorded } = context(executeTool);
    ctx.failedCalls = new FailedCallMemo();
    const hook = vi.fn(async () => undefined);
    const args = { first: "Sophia", zip: "78260" };
    await runToolCall({ name: "find_user", args, toolCallId: "c1" }, ctx, hook);
    const again = await runToolCall({ name: "find_user", args, toolCallId: "c2" }, ctx, hook);
    // In host mode `executeTool` IS the relay: not calling it means the harness
    // never sees the repeat. No hook means no "let me look that up" line.
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(again.result).toContain('"reason":"repeated_failure"');
    expect(again.forModel).toBe(again.result);
    expect(recorded.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
  });

  test("a failure's MODEL copy lists what was tried; its own string and the history do not", async () => {
    const { ctx, recorded } = context(vi.fn<ExecuteTool>(async () => "Error: User not found"));
    ctx.failedCalls = new FailedCallMemo();
    const settled = await runToolCall(
      { name: "find_user", args: { first: "Sophia" }, toolCallId: "c1" },
      ctx,
    );
    expect(settled.result).toBe("Error: User not found");
    expect(settled.instruction).toBe('Already tried, all failed: find_user({"first":"Sophia"})');
    expect(settled.forModel).toBe(
      `Error: User not found\n\n${TOOL_INSTRUCTION_LABEL} Already tried, all failed: find_user({"first":"Sophia"})`,
    );
    expect(recorded[0]?.content).toBe("Error: User not found");
  });

  test("a tool's own instruction comes first, the memo's note after it", async () => {
    const raw = JSON.stringify(withInstruction({ error: "nope" }, "Ask for the email."));
    const { ctx } = context(vi.fn<ExecuteTool>(async () => raw));
    ctx.failedCalls = new FailedCallMemo();
    const settled = await runToolCall({ name: "find_user", args: {}, toolCallId: "c1" }, ctx);
    expect(settled.instruction).toBe(
      "Ask for the email.\nAlready tried, all failed: find_user({})",
    );
  });
});

describe("runToolCall argument prechecks", () => {
  const FIND: JSONSchema7 = {
    type: "object",
    // `zip` says empty is an answer, so an empty one runs and a failure is
    // explained; a parameter that says nothing is refused before it runs
    // (`arg-precheck.test.ts`).
    properties: {
      first_name: { type: "string" },
      zip: { type: "string", description: "The ZIP code, or an empty string when unknown." },
    },
    required: ["first_name", "zip"],
  };
  function withSchema(executeTool: ExecuteTool) {
    const made = context(executeTool);
    made.ctx.parameters = (name) => (name === "find_user" ? FIND : undefined);
    return made;
  }

  test("a refused call never reaches executeTool or the hook, and is recorded", async () => {
    const executeTool = vi.fn<ExecuteTool>(async () => "u1");
    const { ctx, recorded } = withSchema(executeTool);
    const hook = vi.fn(async () => undefined);
    const settled = await runToolCall(
      { name: "find_user", args: { first_name: "unknown", zip: "12345" }, toolCallId: "c1" },
      ctx,
      hook,
    );
    expect(executeTool).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    expect(settled.result).toContain('"reason":"invalid_arguments"');
    expect(recorded.map((m) => m.toolCallId)).toEqual(["c1"]);
  });

  test("a failure with an empty required string says so, ahead of the tried-list", async () => {
    const { ctx } = withSchema(vi.fn<ExecuteTool>(async () => "Error: User not found"));
    ctx.failedCalls = new FailedCallMemo();
    const settled = await runToolCall(
      { name: "find_user", args: { first_name: "Sofia", zip: "" }, toolCallId: "c1" },
      ctx,
    );
    expect(settled.instruction?.split("\n")).toEqual([
      '"zip" was sent empty, so nothing could match. Ask the user for the value rather than retrying without it.',
      'Already tried, all failed: find_user({"first_name":"Sofia","zip":""})',
    ]);
  });

  test("an empty required string on a call that SUCCEEDS is left alone", async () => {
    const { ctx } = withSchema(vi.fn<ExecuteTool>(async () => '{"ok":true}'));
    const settled = await runToolCall(
      { name: "find_user", args: { first_name: "Sofia", zip: "" }, toolCallId: "c1" },
      ctx,
    );
    expect(settled.instruction).toBeUndefined();
  });
});
