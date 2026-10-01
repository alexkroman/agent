// Copyright 2026 the AAI authors. MIT license.
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { flush } from "../_test-utils.ts";
import { PIPELINE_CAPABILITIES } from "../transports/capabilities.ts";
import { makeCore, makeTransport } from "./_core-harness.ts";

/** A transport whose host runs the model turn — the pipeline's descriptor. */
function hostedTransport() {
  return { ...makeTransport(), capabilities: PIPELINE_CAPABILITIES };
}

describe("createSessionCore — the shared tool-call core", () => {
  test("coerces a reported call's stringified scalars toward the declared schema", async () => {
    // The step the pipeline's tools always took, which the S2S path skipped
    // before both ran through `runToolCall`.
    const executeTool = vi.fn<ExecuteTool>(async () => "ok");
    const { core } = makeCore({
      executeTool,
      toolSchemas: [
        {
          type: "function",
          name: "book",
          description: "book a table",
          parameters: {
            type: "object",
            properties: { guests: { type: "integer" }, note: { type: "string" } },
          },
        },
      ],
    });
    await core.start();
    core.onReplyStarted("r1");
    core.report({
      type: "tool.called",
      toolCallId: "c1",
      toolName: "book",
      args: { guests: "4", note: "12" },
    });
    await flush();
    expect(executeTool.mock.calls[0]?.[1]).toEqual({ guests: 4, note: "12" });
  });
});

describe("createSessionCore — a hosted turn's tool reports are observations", () => {
  const called = {
    type: "tool.called",
    toolCallId: "c1",
    toolName: "lookup",
    args: {},
  } as const;
  const completed = { type: "tool.completed", toolCallId: "c1", result: "ok" } as const;

  test("publishes the call and its result, and never runs the tool again", async () => {
    const executeTool = vi.fn<ExecuteTool>(async () => "ok");
    const transport = hostedTransport();
    const { core, sink } = makeCore({ executeTool, transport });
    await core.start();
    core.onReplyStarted("r1");
    core.report(called);
    core.report(completed);
    await flush();
    expect(executeTool).not.toHaveBeenCalled();
    expect(transport.sendToolResult).not.toHaveBeenCalled();
    const types = sink.events.map((e) => e.type);
    expect(types).toContain("tool.called");
    expect(types).toContain("tool.completed");
  });

  test("under a relay, publishes neither: the relay already did", async () => {
    const { core, sink } = makeCore({ transport: hostedTransport(), onToolResult: vi.fn() });
    await core.start();
    core.onReplyStarted("r1");
    core.report(called);
    core.report(completed);
    await flush();
    const types = sink.events.map((e) => e.type);
    expect(types).not.toContain("tool.called");
    expect(types).not.toContain("tool.completed");
  });
});
