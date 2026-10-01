// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createReplyRunner } from "./reply-runner.ts";
import type { TurnMetrics } from "./turn/index.ts";

type Frame = ReturnType<TurnMetrics["finish"]>;

/** Every collaborator as a recording fake, plus the event order across them. */
function fakes() {
  const order: string[] = [];
  const session = new AbortController();
  const deps = {
    speculation: { discard: vi.fn((_reason: string) => void order.push("speculation.discard")) },
    callbacks: {
      onReplyStarted: vi.fn((_replyId: string) => void order.push("onReplyStarted")),
      report: vi.fn((_event: unknown) => void order.push("report")),
    },
    metrics: {
      begin: vi.fn(() => void order.push("metrics.begin")),
      finish: vi.fn((_interrupted: boolean): Frame => {
        order.push("metrics.finish");
        return undefined;
      }),
    },
    armFloor: vi.fn(() => void order.push("armFloor")),
    sessionSignal: session.signal,
    turns: {
      begin: vi.fn((_ctl: AbortController) => void order.push("turns.begin")),
      setDraining: vi.fn((draining: boolean) => void order.push(`draining:${draining}`)),
      settle: vi.fn((_ctl: AbortController) => void order.push("turns.settle")),
    },
    heard: { startReply: vi.fn(() => void order.push("heard.startReply")) },
    drainTts: vi.fn(async (_signal: AbortSignal) => void order.push("drainTts")),
    rearmNudger: vi.fn(() => void order.push("rearmNudger")),
  };
  return { deps, order, session };
}

describe("createReplyRunner", () => {
  test("mints a numbered reply id per call, counting across replies", async () => {
    const { deps } = fakes();
    const run = createReplyRunner(deps);
    await run("turn", async () => false);
    await run("greeting", async () => false);
    expect(deps.callbacks.onReplyStarted.mock.calls).toEqual([["turn-1"], ["greeting-2"]]);
  });

  test("a reply that spoke drains TTS between draining edges, then completes", async () => {
    const { deps, order } = fakes();
    await createReplyRunner(deps)("turn", async () => {
      order.push("body");
      return true;
    });
    expect(order).toEqual([
      "speculation.discard",
      "onReplyStarted",
      "metrics.begin",
      "armFloor",
      "turns.begin",
      "heard.startReply",
      "body",
      "draining:true",
      "drainTts",
      "draining:false",
      "report",
      "turns.settle",
      "metrics.finish",
      "rearmNudger",
    ]);
    expect(deps.speculation.discard).toHaveBeenCalledWith("turn-started");
    expect(deps.callbacks.report).toHaveBeenCalledWith({ type: "reply.completed" });
    expect(deps.metrics.finish).toHaveBeenCalledWith(false);
  });

  test("a silent reply skips the drain (no TTS `done` would ever come)", async () => {
    const { deps } = fakes();
    await createReplyRunner(deps)("turn", async () => false);
    expect(deps.drainTts).not.toHaveBeenCalled();
    expect(deps.turns.setDraining).not.toHaveBeenCalled();
    expect(deps.callbacks.report).toHaveBeenCalledWith({ type: "reply.completed" });
  });

  test("a reply aborted by the SESSION reports no completion and does not re-arm", async () => {
    const { deps, session } = fakes();
    const seen: boolean[] = [];
    await createReplyRunner(deps)("turn", async (signal) => {
      session.abort();
      seen.push(signal.aborted);
      return true;
    });
    // The reply's signal is the session's too.
    expect(seen).toEqual([true]);
    expect(deps.drainTts).not.toHaveBeenCalled();
    expect(deps.callbacks.report).not.toHaveBeenCalled();
    expect(deps.metrics.finish).toHaveBeenCalledWith(true);
    expect(deps.rearmNudger).not.toHaveBeenCalled();
    expect(deps.turns.settle).toHaveBeenCalledTimes(1);
  });

  test("the turn's own controller is the one begun and settled", async () => {
    const { deps } = fakes();
    await createReplyRunner(deps)("turn", async () => false);
    const begun = deps.turns.begin.mock.calls[0]?.[0];
    expect(begun).toBeInstanceOf(AbortController);
    expect(deps.turns.settle).toHaveBeenCalledWith(begun);
  });

  test("a collected metrics frame is reported after the completion", async () => {
    const { deps } = fakes();
    const frame = { type: "metrics.collected", interrupted: false } as const;
    deps.metrics.finish.mockReturnValue(frame);
    await createReplyRunner(deps)("turn", async () => false);
    expect(deps.callbacks.report.mock.calls).toEqual([[{ type: "reply.completed" }], [frame]]);
  });

  test("a body that throws still settles the turn and finishes metrics", async () => {
    const { deps } = fakes();
    const run = createReplyRunner(deps);
    await expect(
      run("turn", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(deps.turns.settle).toHaveBeenCalledTimes(1);
    expect(deps.metrics.finish).toHaveBeenCalledTimes(1);
  });
});
