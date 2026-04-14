// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_HISTORY } from "../sdk/constants.ts";
import type { Message } from "../sdk/types.ts";
import { toolError } from "../sdk/utils.ts";
import { flush, makeClient, makeConfig, silentLogger } from "./_test-utils.ts";
import { buildCtx } from "./session-ctx.ts";

function makeBuildCtxOpts(overrides?: Record<string, unknown>) {
  return {
    id: "session-1",
    agent: "test-agent",
    client: makeClient(),
    agentConfig: makeConfig({ maxSteps: 3 }),
    executeTool: vi.fn(async () => "ok"),
    log: silentLogger,
    ...overrides,
  };
}

describe("buildCtx", () => {
  it("returns ctx with the correct session id", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ id: "my-session" }));
    expect(ctx.id).toBe("my-session");
  });

  it("returns ctx with the correct agent name", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ agent: "my-agent" }));
    expect(ctx.agent).toBe("my-agent");
  });

  it("initializes with empty conversation messages", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    expect(ctx.conversationMessages).toEqual([]);
  });

  it("initializes with null s2s handle", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    expect(ctx.s2s).toBeNull();
  });

  it("initializes with null turnPromise", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    expect(ctx.turnPromise).toBeNull();
  });

  it("initializes reply state with empty pendingTools, zero toolCallCount, and null replyId", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    expect(ctx.reply).toEqual({
      pendingTools: [],
      toolCallCount: 0,
      currentReplyId: null,
    });
  });

  it("defaults maxHistory to DEFAULT_MAX_HISTORY when not provided", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    expect(ctx.maxHistory).toBe(DEFAULT_MAX_HISTORY);
  });

  it("uses custom maxHistory when provided", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ maxHistory: 50 }));
    expect(ctx.maxHistory).toBe(50);
  });

  it("passes through the agentConfig, executeTool, and log dependencies", () => {
    const config = makeConfig({ maxSteps: 7 });
    const executeTool = vi.fn(async () => "done");
    const ctx = buildCtx(makeBuildCtxOpts({ agentConfig: config, executeTool }));
    expect(ctx.agentConfig).toBe(config);
    expect(ctx.executeTool).toBe(executeTool);
    expect(ctx.log).toBe(silentLogger);
  });
});

describe("consumeToolCallStep", () => {
  it("returns null (success) when tool call is within maxSteps", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    ctx.beginReply("reply-1");
    const result = ctx.consumeToolCallStep("my-tool", "reply-1");
    expect(result).toBeNull();
  });

  it("increments toolCallCount on each call", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    ctx.beginReply("reply-1");

    ctx.consumeToolCallStep("tool-a", "reply-1");
    expect(ctx.reply.toolCallCount).toBe(1);

    ctx.consumeToolCallStep("tool-b", "reply-1");
    expect(ctx.reply.toolCallCount).toBe(2);
  });

  it("allows exactly maxSteps tool calls", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ agentConfig: makeConfig({ maxSteps: 2 }) }));
    ctx.beginReply("reply-1");

    expect(ctx.consumeToolCallStep("tool-1", "reply-1")).toBeNull();
    expect(ctx.consumeToolCallStep("tool-2", "reply-1")).toBeNull();
  });

  it("rejects when tool call count exceeds maxSteps", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ agentConfig: makeConfig({ maxSteps: 2 }) }));
    ctx.beginReply("reply-1");

    ctx.consumeToolCallStep("tool-1", "reply-1");
    ctx.consumeToolCallStep("tool-2", "reply-1");
    const result = ctx.consumeToolCallStep("tool-3", "reply-1");
    expect(result).toBe(toolError("Maximum tool steps reached. Please respond to the user now."));
  });

  it("logs when maxSteps is exceeded", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = buildCtx(makeBuildCtxOpts({ agentConfig: makeConfig({ maxSteps: 1 }), log }));
    ctx.beginReply("reply-1");

    ctx.consumeToolCallStep("tool-1", "reply-1"); // ok
    ctx.consumeToolCallStep("tool-2", "reply-1"); // exceeds

    expect(log.info).toHaveBeenCalledWith("maxSteps exceeded, refusing tool call", {
      toolCallCount: 2,
      maxSteps: 1,
    });
  });

  it("rejects with stale replyId (mismatched)", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    ctx.beginReply("reply-1");

    const result = ctx.consumeToolCallStep("my-tool", "stale-reply");
    expect(result).toBe(toolError("Reply was interrupted. Discarding stale tool call."));
  });

  it("rejects when replyId is null", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    ctx.beginReply("reply-1");

    const result = ctx.consumeToolCallStep("my-tool", null);
    expect(result).toBe(toolError("Reply was interrupted. Discarding stale tool call."));
  });

  it("rejects when no reply has been started (currentReplyId is null)", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    // No beginReply — currentReplyId stays null
    const result = ctx.consumeToolCallStep("my-tool", "some-reply");
    expect(result).toBe(toolError("Reply was interrupted. Discarding stale tool call."));
  });

  it("allows unlimited tool calls when maxSteps is undefined", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ agentConfig: makeConfig() }));
    ctx.beginReply("reply-1");

    // makeConfig() without maxSteps leaves it undefined
    for (let i = 0; i < 100; i++) {
      expect(ctx.consumeToolCallStep(`tool-${i}`, "reply-1")).toBeNull();
    }
  });
});

describe("pushMessages", () => {
  it("appends messages to conversationMessages", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    const msg1: Message = { role: "user", content: "hello" };
    const msg2: Message = { role: "assistant", content: "hi" };

    ctx.pushMessages(msg1);
    expect(ctx.conversationMessages).toEqual([msg1]);

    ctx.pushMessages(msg2);
    expect(ctx.conversationMessages).toEqual([msg1, msg2]);
  });

  it("accepts multiple messages at once", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    const msg1: Message = { role: "user", content: "a" };
    const msg2: Message = { role: "assistant", content: "b" };
    const msg3: Message = { role: "tool", content: "c" };

    ctx.pushMessages(msg1, msg2, msg3);
    expect(ctx.conversationMessages).toEqual([msg1, msg2, msg3]);
  });

  it("trims to maxHistory keeping the most recent messages", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ maxHistory: 3 }));

    ctx.pushMessages(
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
    );
    expect(ctx.conversationMessages).toHaveLength(3);

    ctx.pushMessages({ role: "assistant", content: "4" });
    expect(ctx.conversationMessages).toHaveLength(3);
    expect(ctx.conversationMessages.map((m) => m.content)).toEqual(["2", "3", "4"]);
  });

  it("trims correctly when pushing multiple messages that exceed maxHistory", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ maxHistory: 2 }));

    ctx.pushMessages(
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    );

    expect(ctx.conversationMessages).toHaveLength(2);
    expect(ctx.conversationMessages.map((m) => m.content)).toEqual(["c", "d"]);
  });

  it("does not trim when maxHistory is 0 (disabled)", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ maxHistory: 0 }));

    for (let i = 0; i < 300; i++) {
      ctx.pushMessages({ role: "user", content: `msg-${i}` });
    }
    expect(ctx.conversationMessages).toHaveLength(300);
  });
});

describe("cancelReply", () => {
  it("resets pendingTools and toolCallCount", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    ctx.beginReply("reply-1");
    ctx.consumeToolCallStep("tool-1", "reply-1");
    ctx.reply.pendingTools.push({ callId: "c1", result: "r1" });

    expect(ctx.reply.toolCallCount).toBe(1);
    expect(ctx.reply.pendingTools).toHaveLength(1);

    ctx.cancelReply();

    expect(ctx.reply.toolCallCount).toBe(0);
    expect(ctx.reply.pendingTools).toEqual([]);
    expect(ctx.reply.currentReplyId).toBeNull();
  });

  it("allows a new reply to start fresh after cancel", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ agentConfig: makeConfig({ maxSteps: 1 }) }));
    ctx.beginReply("reply-1");
    ctx.consumeToolCallStep("tool-1", "reply-1"); // uses the single step

    ctx.cancelReply();
    ctx.beginReply("reply-2");

    // Should succeed because toolCallCount was reset
    const result = ctx.consumeToolCallStep("tool-1", "reply-2");
    expect(result).toBeNull();
  });
});

describe("beginReply", () => {
  it("resets reply state with the given replyId", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    ctx.beginReply("reply-1");

    expect(ctx.reply.currentReplyId).toBe("reply-1");
    expect(ctx.reply.pendingTools).toEqual([]);
    expect(ctx.reply.toolCallCount).toBe(0);
  });

  it("clears turnPromise", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    ctx.chainTurn(Promise.resolve());
    expect(ctx.turnPromise).not.toBeNull();

    ctx.beginReply("reply-1");
    expect(ctx.turnPromise).toBeNull();
  });

  it("resets toolCallCount from a previous reply", () => {
    const ctx = buildCtx(makeBuildCtxOpts({ agentConfig: makeConfig({ maxSteps: 2 }) }));
    ctx.beginReply("reply-1");
    ctx.consumeToolCallStep("tool-a", "reply-1");
    ctx.consumeToolCallStep("tool-b", "reply-1");
    expect(ctx.reply.toolCallCount).toBe(2);

    ctx.beginReply("reply-2");
    expect(ctx.reply.toolCallCount).toBe(0);

    // Can now use maxSteps again
    expect(ctx.consumeToolCallStep("tool-a", "reply-2")).toBeNull();
    expect(ctx.consumeToolCallStep("tool-b", "reply-2")).toBeNull();
  });

  it("invalidates tool calls from the previous reply", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    ctx.beginReply("reply-1");
    ctx.beginReply("reply-2");

    // Tool call using old replyId should be rejected
    const result = ctx.consumeToolCallStep("my-tool", "reply-1");
    expect(result).toBe(toolError("Reply was interrupted. Discarding stale tool call."));
  });
});

describe("chainTurn", () => {
  it("sets turnPromise on first call", () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    expect(ctx.turnPromise).toBeNull();

    ctx.chainTurn(Promise.resolve());
    expect(ctx.turnPromise).not.toBeNull();
  });

  it("chains promises sequentially", async () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    const order: number[] = [];

    ctx.chainTurn(
      new Promise<void>((resolve) => {
        queueMicrotask(() => {
          order.push(1);
          resolve();
        });
      }),
    );

    ctx.chainTurn(
      new Promise<void>((resolve) => {
        queueMicrotask(() => {
          order.push(2);
          resolve();
        });
      }),
    );

    await ctx.turnPromise;
    await flush();
    expect(order).toEqual([1, 2]);
  });

  it("continues the chain even if a prior turn rejects", async () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    const order: string[] = [];

    ctx.chainTurn(
      new Promise<void>((_, reject) => {
        queueMicrotask(() => {
          order.push("fail");
          reject(new Error("boom"));
        });
      }),
    );

    ctx.chainTurn(
      new Promise<void>((resolve) => {
        queueMicrotask(() => {
          order.push("success");
          resolve();
        });
      }),
    );

    // The chain uses .then() which means rejection propagates.
    // We need to catch the final promise to avoid unhandled rejection.
    try {
      await ctx.turnPromise;
    } catch {
      // expected
    }
    await flush();

    expect(order).toContain("fail");
  });

  it("allows awaiting turnPromise to wait for all chained turns", async () => {
    const ctx = buildCtx(makeBuildCtxOpts());
    let completed = false;

    ctx.chainTurn(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          completed = true;
          resolve();
        }, 10);
      }),
    );

    expect(completed).toBe(false);
    await ctx.turnPromise;
    expect(completed).toBe(true);
  });
});
