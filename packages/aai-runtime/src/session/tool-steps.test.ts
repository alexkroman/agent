// Copyright 2026 the AAI authors. MIT license.
// `runToolStep`, through `createSessionCore`: a settled call's result waits for
// its reply's `reply.done` to reach the transport, the provider reads a record
// collection as rows while the event keeps the tool's own string, and a
// barged-in reply's late result is never routed into the next one.

import { describe, expect, test, vi } from "vitest";
import { flush } from "../_timing-test-utils.ts";
import { makeCore } from "./_core-harness.ts";

describe("createSessionCore — tool call pending results", () => {
  test("tool_call executes, tool_call_done fires, reply_done forwards results to transport", async () => {
    const executeTool = vi.fn(async () => "tool-output");
    const { core, sink, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid", toolName: "my_tool", args: {} });
    await flush();
    core.report({ type: "reply.completed" });
    await vi.waitFor(() =>
      expect(transport.sendToolResult).toHaveBeenCalledWith("cid", "tool-output"),
    );
    expect(sink.events).toContainEqual(expect.objectContaining({ type: "tool.completed" }));
  });

  test("the provider reads a record collection as rows; the tool.completed event keeps the tool's own string", async () => {
    const raw = JSON.stringify([
      { id: "1", ok: true },
      { id: "2", ok: false },
      { id: "3", ok: true },
    ]);
    const { core, sink, transport } = makeCore({ executeTool: vi.fn(async () => raw) });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid", toolName: "my_tool", args: {} });
    await flush();
    core.report({ type: "reply.completed" });
    const rows =
      "3 records (key column: index): index | id | ok\n0 | 1 | true\n1 | 2 | false\n2 | 3 | true";
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("cid", rows));
    expect(sink.events).toContainEqual(
      expect.objectContaining({ type: "tool.completed", result: raw }),
    );
  });

  test("a barged-in reply's late tool result is not forwarded to the next reply", async () => {
    const slow = Promise.withResolvers<string>();
    const executeTool = vi.fn(() => slow.promise);
    const { core, transport } = makeCore({ executeTool });
    await core.start();

    // Reply r1 issues a slow tool and completes its turn (done is queued
    // behind the pending tool).
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid1", toolName: "slow", args: {} });
    core.report({ type: "reply.completed" });

    // Barge-in cancels r1; a new reply r2 starts.
    core.report({ type: "reply.cancelled" });
    core.onReplyStarted("r2");

    // r1's tool finally resolves — its result belongs to the cancelled reply
    // and must not be routed into r2.
    slow.resolve("slow-output");
    await flush();
    core.report({ type: "reply.completed" });
    await flush();

    expect(transport.sendToolResult).not.toHaveBeenCalledWith("cid1", "slow-output");
  });
});
