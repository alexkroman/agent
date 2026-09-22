// Copyright 2026 the AAI authors. MIT license.
// The push-to-talk half of the command dispatcher: what the SESSION does with
// `user_turn_start` / `user_turn_commit` / `user_turn_clear`. The transport's
// half — what a turn holds and when it is answered — is
// `transports/pipeline-manual-turn.test.ts`.

import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { makeCore } from "./_session-core-harness.ts";
import { flush, makeLogger } from "./_test-utils.ts";

/** A transport that has the three verbs, as the pipeline transport does. */
function withTurnVerbs(transport: object, interrupted: boolean) {
  const verbs = {
    startUserTurn: vi.fn(() => interrupted),
    commitUserTurn: vi.fn(),
    clearUserTurn: vi.fn(),
  };
  Object.assign(transport, verbs);
  return verbs;
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
