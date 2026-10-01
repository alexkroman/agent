// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createReplyTracker } from "./reply-tracker.ts";

describe("createReplyTracker", () => {
  test("starts on an id-less reply with no chained work", () => {
    const replies = createReplyTracker();
    expect(replies.current()).toMatchObject({
      currentReplyId: null,
      pendingTools: [],
      toolCallCount: 0,
      flushedAwaitingContinuation: false,
    });
    expect(replies.turnPromise()).toBeNull();
  });

  test("begin swaps in a fresh reply, aborts the replaced one and drops its chain", () => {
    const replies = createReplyTracker();
    const first = replies.current();
    replies.chainTool(Promise.resolve());
    replies.begin("r1");
    expect(first.abort.signal.aborted).toBe(true);
    expect(replies.current()).not.toBe(first);
    expect(replies.current().currentReplyId).toBe("r1");
    expect(replies.current().abort.signal.aborted).toBe(false);
    expect(replies.turnPromise()).toBeNull();
  });

  test("cancel aborts and drops to an id-less reply, but KEEPS the chain", () => {
    const replies = createReplyTracker();
    replies.begin("r1");
    const live = replies.current();
    replies.chainTool(Promise.resolve());
    const chain = replies.turnPromise();
    replies.cancel();
    expect(live.abort.signal.aborted).toBe(true);
    expect(replies.current().currentReplyId).toBeNull();
    expect(replies.turnPromise()).toBe(chain);
  });

  test("abortTools aborts the current reply without replacing it", () => {
    const replies = createReplyTracker();
    replies.begin("r1");
    const live = replies.current();
    replies.abortTools();
    expect(replies.current()).toBe(live);
    expect(live.abort.signal.aborted).toBe(true);
  });

  test("chained steps settle in order, and the chain waits for the last one", async () => {
    const replies = createReplyTracker();
    const settled: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }).then(() => {
      settled.push("first");
    });
    replies.chainTool(first);
    replies.chainTool(Promise.resolve().then(() => void settled.push("second")));
    const chain = replies.turnPromise();
    expect(chain).not.toBeNull();
    releaseFirst();
    await chain;
    expect(settled).toEqual(["second", "first"]);
    // The chain resolved only after BOTH steps — the order they settled in is
    // their own; what the chain owes is waiting for the slower one.
    expect(settled).toHaveLength(2);
  });
});
