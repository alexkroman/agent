// Copyright 2026 the AAI authors. MIT license.
// The user-turn half of the command dispatcher: what the SESSION does with
// `user_turn_start` / `user_turn_commit` / `user_turn_clear` and the typed
// `user_text`. The transport's half — what a turn holds and when it is
// answered — is `transports/pipeline-manual-turn.test.ts` and
// `transports/pipeline-typed-turn.test.ts`.

import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { makeCore } from "./_session-core-harness.ts";
import { flush, makeLogger } from "./_test-utils.ts";
import type { Transport } from "./transports/types.ts";

/** A transport that has the three verbs, as the pipeline transport does. */
function withTurnVerbs(transport: Transport, interrupted: boolean) {
  const verbs = {
    startUserTurn: vi.fn(() => interrupted),
    commitUserTurn: vi.fn(),
    clearUserTurn: vi.fn(),
  };
  Object.assign(transport, verbs, {
    capabilities: { ...transport.capabilities, manualTurn: true },
  });
  return verbs;
}

/** A transport that takes a typed turn, as the pipeline transport does. */
function withTypedTurn(transport: Transport, sendUserText: (text: string) => void): void {
  Object.assign(transport, {
    sendUserText,
    capabilities: { ...transport.capabilities, typedTurn: true },
  });
}

describe("session commands — push-to-talk", () => {
  test("each command reaches its transport verb", async () => {
    const { core, transport } = makeCore();
    const verbs = withTurnVerbs(transport, false);
    await core.start();

    core.command({ type: "user_turn_start" });
    core.command({ type: "user_turn_commit" });
    core.command({ type: "user_turn_clear" });
    expect(verbs.startUserTurn).toHaveBeenCalledOnce();
    expect(verbs.commitUserTurn).toHaveBeenCalledOnce();
    expect(verbs.clearUserTurn).toHaveBeenCalledOnce();
  });

  test("a start that interrupted the agent cancels the reply the way `cancel` does", async () => {
    let seenSignal: AbortSignal | undefined;
    const executeTool: ExecuteTool = async (_n, _a, _s, _m, callOpts) => {
      seenSignal = callOpts?.signal;
      return "ok";
    };
    const { core, transport, sink } = makeCore({ executeTool });
    withTurnVerbs(transport, true);
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "c1", toolName: "lookup", args: {} });

    core.command({ type: "user_turn_start" });
    expect(seenSignal?.aborted).toBe(true);
    expect(sink.events.some((e) => e.type === "reply.cancelled")).toBe(true);
    await flush();
  });

  test("a start into silence reports no cancellation that did not happen", async () => {
    const { core, transport, sink } = makeCore();
    withTurnVerbs(transport, false);
    await core.start();
    core.command({ type: "user_turn_start" });
    expect(sink.events.some((e) => e.type === "reply.cancelled")).toBe(false);
  });

  test("a transport with no turn verbs ignores all three and says so once", async () => {
    // Both S2S transports: the service owns the caller's turn.
    const logger = makeLogger();
    const { core, transport, sink } = makeCore({ logger });
    expect(transport.startUserTurn).toBeUndefined();
    await core.start();

    core.command({ type: "user_turn_start" });
    core.command({ type: "user_turn_commit" });
    core.command({ type: "user_turn_clear" });
    core.command({ type: "user_turn_start" });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[0]).toMatch(/push-to-talk needs a pipeline agent/);
    expect(sink.events.some((e) => e.type === "reply.cancelled")).toBe(false);
  });
});

describe("session commands — a typed turn", () => {
  test("reaches the transport's verb, and what the transport reports is RECORDED", async () => {
    // A pipeline transport answers `sendUserText` by reporting the committed
    // turn itself; the session's part is to make that report the same fact a
    // spoken turn is — in the retained stream, where `messages` and a resume
    // read it.
    const { core, transport, stream } = makeCore();
    const sendUserText = vi.fn((text: string) => {
      core.report({ type: "user-transcript.committed", text });
    });
    withTypedTurn(transport, sendUserText);
    await core.start();

    core.command({ type: "user_text", text: "what's on today" });
    expect(sendUserText).toHaveBeenCalledExactlyOnceWith("what's on today");
    const page = await stream.read("s-test", 0);
    expect(page.events).toContainEqual(
      expect.objectContaining({ type: "user-transcript.committed", text: "what's on today" }),
    );
  });

  test("the session adds no cancel of its own — the transport reports the one it made", async () => {
    // A second `reply.cancelled` from the dispatcher would land AFTER the new
    // turn's transcript, in the wrong order and once too often.
    const { core, transport, sink } = makeCore();
    withTypedTurn(transport, vi.fn());
    await core.start();
    core.onReplyStarted("r1");
    core.command({ type: "user_text", text: "stop" });
    expect(sink.events.some((e) => e.type === "reply.cancelled")).toBe(false);
  });

  test("a transport that cannot take text ignores it and says so once", async () => {
    // Both S2S transports: the service owns its conversation and has no text input.
    const logger = makeLogger();
    const { core, transport, sink } = makeCore({ logger });
    expect(transport.sendUserText).toBeUndefined();
    await core.start();
    const before = sink.events.length;

    core.command({ type: "user_text", text: "hello" });
    core.command({ type: "user_text", text: "hello?" });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[0]).toMatch(/typed turns need a pipeline agent/);
    expect(sink.events.slice(before)).toEqual([]);
  });
});
