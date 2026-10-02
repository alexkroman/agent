// Copyright 2026 the AAI authors. MIT license.
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { makeConfig } from "../_agent-test-utils.ts";
import { makeLogger } from "../_logger-test-utils.ts";
import { flush } from "../_timing-test-utils.ts";
import type { TransportEventBody } from "../transports/types.ts";
import type { SessionEmitter } from "./emitter.ts";
import { createReplyTracker } from "./reply-tracker.ts";
import { createReportDispatcher } from "./report.ts";

function harness(opts: { hosted?: boolean; relayed?: boolean; stopped?: boolean } = {}) {
  const emit = vi.fn<SessionEmitter["emit"]>();
  const executeTool = vi.fn<ExecuteTool>(async () => "ok");
  const replies = createReplyTracker();
  const resetIdle = vi.fn();
  const pushConversation = vi.fn<(event: TransportEventBody) => void>();
  const recordFault = vi.fn<(code: string) => void>();
  const sendToolResult = vi.fn<(callId: string, result: string) => void>();
  const log = makeLogger();
  const report = createReportDispatcher({
    sessionId: "s1",
    emit,
    log,
    isStopped: () => opts.stopped === true,
    resetIdle,
    replies,
    toolStepDeps: {
      sessionId: "s1",
      agentConfig: makeConfig(),
      toolCall: {
        executeTool,
        sessionId: "s1",
        messages: () => [],
        recordToolResult: vi.fn(),
      },
      conversation: () => 0,
      emit,
      log,
      relayed: opts.relayed === true,
    },
    isHostedTurn: () => opts.hosted === true,
    replyDoneDeps: {
      sessionId: "s1",
      agent: "agent",
      emit,
      log,
      currentReply: () => replies.current(),
      turnPromise: () => replies.turnPromise(),
      sendToolResult,
    },
    pushConversation,
    recordFault,
  });
  return { report, emit, executeTool, replies, resetIdle, pushConversation, recordFault, log };
}

const called = {
  type: "tool.called",
  toolCallId: "c1",
  toolName: "lookup",
  args: {},
} as const satisfies TransportEventBody<"tool.called">;

describe("createReportDispatcher — tool.called", () => {
  test("a SERVICE-run turn executes the call and chains it onto the reply", async () => {
    const h = harness();
    h.replies.begin("r1");
    h.report(called);
    expect(h.resetIdle).toHaveBeenCalled();
    expect(h.replies.turnPromise()).not.toBeNull();
    await flush();
    expect(h.executeTool).toHaveBeenCalledTimes(1);
    expect(h.executeTool.mock.calls[0]?.[0]).toBe("lookup");
  });

  test("a HOSTED turn's call is an observation: published, never executed", () => {
    const h = harness({ hosted: true });
    h.report(called);
    expect(h.emit).toHaveBeenCalledWith(called);
    expect(h.executeTool).not.toHaveBeenCalled();
    expect(h.replies.turnPromise()).toBeNull();
  });

  test("a hosted call under a RELAY is not published twice", () => {
    const h = harness({ hosted: true, relayed: true });
    h.report(called);
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.executeTool).not.toHaveBeenCalled();
  });

  test("a call arriving after stop() starts no tool work", async () => {
    const h = harness({ stopped: true });
    h.report(called);
    await flush();
    expect(h.executeTool).not.toHaveBeenCalled();
    expect(h.replies.turnPromise()).toBeNull();
  });
});

describe("createReportDispatcher — conversation and idle", () => {
  test("a committed user transcript re-arms idle, is published and enters history", () => {
    const h = harness();
    const event = { type: "userTranscript.committed", text: "hi" } as const;
    h.report(event);
    expect(h.resetIdle).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith(event);
    expect(h.pushConversation).toHaveBeenCalledWith(event);
  });

  test("agent transcripts clear the awaiting-continuation flag; only COMMITTED enters history", () => {
    const h = harness();
    h.replies.current().flushedAwaitingContinuation = true;
    h.report({ type: "agentTranscript.updated", text: "par" });
    expect(h.replies.current().flushedAwaitingContinuation).toBe(false);
    expect(h.pushConversation).not.toHaveBeenCalled();

    h.replies.current().flushedAwaitingContinuation = true;
    h.report({ type: "agentTranscript.committed", text: "partial reply" });
    expect(h.replies.current().flushedAwaitingContinuation).toBe(false);
    expect(h.pushConversation).toHaveBeenCalledTimes(1);
  });

  test("partials and the speaking edge re-arm idle and are published", () => {
    const h = harness();
    h.report({ type: "userTranscript.updated", text: "hel" });
    h.report({ type: "speech.started" });
    expect(h.resetIdle).toHaveBeenCalledTimes(2);
    expect(h.emit).toHaveBeenCalledTimes(2);
  });

  test("reply.cancelled drops the reply and is published", () => {
    const h = harness();
    h.replies.begin("r1");
    const live = h.replies.current();
    h.report({ type: "reply.cancelled" });
    expect(live.abort.signal.aborted).toBe(true);
    expect(h.replies.current().currentReplyId).toBeNull();
    expect(h.emit).toHaveBeenCalledWith({ type: "reply.cancelled" });
  });
});

describe("createReportDispatcher — errors", () => {
  test("a fatal error is logged as a warning and recorded as the fault", () => {
    const h = harness();
    const event = {
      type: "error.reported",
      code: "connection",
      message: "gone",
      fatal: true,
    } as const;
    h.report(event);
    expect(h.log.warn).toHaveBeenCalledWith("session error (fatal)", {
      sid: "s1",
      code: "connection",
      message: "gone",
    });
    expect(h.recordFault).toHaveBeenCalledWith("connection");
    expect(h.emit).toHaveBeenCalledWith(event);
  });

  test("a non-fatal error is debug-logged, recorded nowhere, and still published", () => {
    const h = harness();
    h.report({ type: "error.reported", code: "internal", message: "meh", fatal: false });
    expect(h.log.debug).toHaveBeenCalledWith("session error", expect.anything());
    expect(h.recordFault).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledTimes(1);
  });
});

describe("createReportDispatcher — forwarded reports", () => {
  const relaySuppressed = [
    { type: "audio.completed" },
    { type: "tool.completed", toolCallId: "c1", result: "ok" },
  ] as const;

  test.each(relaySuppressed)("%o is published without a relay", (event) => {
    const h = harness();
    h.report(event);
    expect(h.emit).toHaveBeenCalledWith(event);
  });

  test.each(relaySuppressed)("%o is NOT published under a relay", (event) => {
    const h = harness({ relayed: true });
    h.report(event);
    expect(h.emit).not.toHaveBeenCalled();
  });

  test("speech.stopped is published even under a relay", () => {
    const h = harness({ relayed: true });
    h.report({ type: "speech.stopped" });
    expect(h.emit).toHaveBeenCalledWith({ type: "speech.stopped" });
  });
});
