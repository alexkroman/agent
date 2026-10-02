// Copyright 2026 the AAI authors. MIT license.
// `dispatchReplyDone`, through `createSessionCore`: one `reply.completed` per
// turn however many `reply.done` frames arrive, and a tool-carrying hop flushes
// its results rather than ending the turn.

import { describe, expect, test, vi } from "vitest";
import { flush } from "../_timing-test-utils.ts";
import { makeCore } from "./_core-harness.ts";

describe("createSessionCore — reply dedup", () => {
  test("first reply.done emits reply.completed + audio.completed", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "reply.completed" });
    expect(sink.events).toContainEqual(expect.objectContaining({ type: "reply.completed" }));
    // `audio.completed` is an EVENT now, not a `playAudioDone()` on the sink —
    // which is what put it in the retained stream. The sink is what keeps it
    // behind held audio, by type.
    expect(sink.events).toContainEqual(expect.objectContaining({ type: "audio.completed" }));
  });
  test("duplicate reply_done is dropped", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "reply.completed" });
    core.report({ type: "reply.completed" });
    const dones = sink.events.filter((e) => e.type === "reply.completed");
    expect(dones).toHaveLength(1);
  });
  test("onCancelled clears currentReplyId so subsequent replyDone is dropped", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "reply.cancelled" });
    core.report({ type: "reply.completed" });
    expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(0);
  });
});

describe("createSessionCore — duplicate reply.done in multi-hop turns", () => {
  test("duplicate reply.done after a tool-result flush does not end the turn early", async () => {
    const executeTool = vi.fn(async () => "out");
    const { core, sink, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid", toolName: "t", args: {} });
    await flush();
    core.report({ type: "reply.completed" }); // flushes the tool result to the transport
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("cid", "out"));

    core.report({ type: "reply.completed" }); // duplicated frame from the service
    await flush();
    await flush();
    await flush();
    expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(0);

    // The real continuation arrives and ends the turn exactly once.
    core.report({ type: "agentTranscript.committed", text: "answer" });
    core.report({ type: "reply.completed" });
    await vi.waitFor(() =>
      expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(1),
    );
  });

  test("multi-hop: each reply.done flushes that hop's results; the final one ends the turn", async () => {
    const executeTool = vi.fn(async () => "out");
    const { core, sink, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");

    core.report({ type: "tool.called", toolCallId: "c1", toolName: "t", args: {} });
    await flush();
    core.report({ type: "reply.completed" });
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("c1", "out"));
    expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(0);

    core.report({ type: "tool.called", toolCallId: "c2", toolName: "t", args: {} }); // continuation hop
    await flush();
    core.report({ type: "reply.completed" });
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("c2", "out"));
    expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(0);

    core.report({ type: "agentTranscript.committed", text: "final answer" });
    core.report({ type: "reply.completed" });
    await vi.waitFor(() =>
      expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(1),
    );
  });
});
