// Copyright 2026 the AAI authors. MIT license.
// The per-reply audit (`reply.ts`): what `reply.done` reports about a reply's
// audio and transcript, and the two anomalies it warns about — driven through
// connectS2s, which is where the audit is kept. Shared helpers in
// _s2s-test-utils.ts.

import { describe, expect, test, vi } from "vitest";
import { createTestS2s, emitMessage, makeMockCallbacks, s2sConfig } from "./_s2s-test-utils.ts";
import { connectS2s } from "./client.ts";
import { appendReplyDelta, createReplyAudit, replyAnomaly, replyAuditFields } from "./reply.ts";

// `reply.audio` is deliberately unlogged (~95% of inbound traffic), which left
// the two ways a reply can fail indistinguishable in the logs: a reply that
// streamed audio but never sent `transcript.agent` and one that produced nothing
// at all both appear as a bare `reply.started` → `reply.done` pair. Both occur
// against the live service, and they have different causes.
describe("connectS2s reply accounting", () => {
  async function setupWithLogSpies(sid = "sess-abc") {
    const { raw, createWebSocket, logger } = createTestS2s();
    const info = vi.fn();
    const warn = vi.fn();
    logger.info = info;
    logger.warn = warn;
    await connectS2s({
      apiKey: "test-key",
      config: s2sConfig,
      createWebSocket,
      callbacks: makeMockCallbacks(),
      logger,
      sid,
    });
    return { raw, info, warn };
  }

  function replyDoneFields(info: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const calls = info.mock.calls.filter((c) => c[0] === "S2S << reply.done");
    return (calls.at(-1)?.[1] ?? {}) as Record<string, unknown>;
  }

  function audioFrame(bytes: number[]): Record<string, unknown> {
    return { type: "reply.audio", data: Buffer.from(bytes).toString("base64") };
  }

  test("reply.done reports the reply's audio and transcript accounting", async () => {
    const { raw, info } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, audioFrame([1, 2, 3, 4]));
    emitMessage(raw, audioFrame([5, 6]));
    emitMessage(raw, { type: "transcript.agent", text: "Hi there." });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(replyDoneFields(info)).toMatchObject({
      audioChunks: 2,
      audioBytes: 6,
      agentText: "final",
    });
  });

  test("accounting is per reply, not cumulative", async () => {
    const { raw, info } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, audioFrame([1, 2, 3, 4]));
    emitMessage(raw, { type: "transcript.agent", text: "one" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    emitMessage(raw, { type: "reply.started", reply_id: "r2" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(replyDoneFields(info)).toMatchObject({
      audioChunks: 0,
      audioBytes: 0,
      agentText: "none",
    });
  });

  // This is the "audio plays but no text appears" symptom, and it is what every
  // tool-call turn looks like against the live service: the reply after
  // `tool.result` streams audio and never sends transcript.agent. Nothing in
  // the log named it before.
  test("warns when a completed reply delivered audio but no transcript", async () => {
    const { raw, warn } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, audioFrame([1, 2]));
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no transcript"),
      expect.objectContaining({ sid: "sess-abc", audioChunks: 1 }),
    );
  });

  // The "goes silent after tool calls" symptom.
  test("warns when a completed reply produced no audio at all", async () => {
    const { raw, warn } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no audio"),
      expect.objectContaining({ sid: "sess-abc" }),
    );
  });

  // A tool-call reply carries the call and nothing else by design — it is the
  // one shape that legitimately has neither audio nor text.
  test("does not warn about a tool-call reply carrying no audio or transcript", async () => {
    const { raw, warn } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "fc-c1" });
    emitMessage(raw, { type: "tool.call", call_id: "c1", name: "get_order", arguments: {} });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(warn).not.toHaveBeenCalled();
  });

  // An interrupted reply is expected to be partial; warning on it would fire on
  // every barge-in, which is normal conversation.
  test("does not warn about an interrupted reply", async () => {
    const { raw, warn } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "interrupted" });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the audit's pure half", () => {
  test("appendReplyDelta joins words with a space and ignores an empty delta", () => {
    const audit = createReplyAudit();
    expect(appendReplyDelta(audit, "Hello")).toBe("Hello");
    expect(appendReplyDelta(audit, "")).toBe("Hello");
    expect(appendReplyDelta(audit, "there")).toBe("Hello there");
  });

  test("a reply covered by deltas alone reads as `delta`, and is not an anomaly", () => {
    const audit = createReplyAudit();
    audit.audioChunks = 1;
    appendReplyDelta(audit, "Hi");
    expect(replyAuditFields(audit).agentText).toBe("delta");
    expect(replyAnomaly(audit, "completed")).toBeUndefined();
  });
});
