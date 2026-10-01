// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { withS2sTurnMetrics } from "./s2s-turn-metrics.ts";
import type { TransportCallbacks, TransportEventBody } from "./types.ts";

function harness() {
  const reported: TransportEventBody[] = [];
  const inner: TransportCallbacks = {
    report: (event) => reported.push(event),
    onAudioChunk: vi.fn(),
    onReplyStarted: vi.fn(),
  };
  let clock = 1000;
  const cb = withS2sTurnMetrics(inner, () => clock);
  const advance = (ms: number) => {
    clock += ms;
  };
  const frames = () => reported.filter((e) => e.type === "metrics.collected");
  return { cb, inner, reported, advance, frames };
}

const audio = new Uint8Array(4);

describe("withS2sTurnMetrics", () => {
  test("a spoken reply reports end-of-speech to first audio, after the settling event", () => {
    const { cb, inner, reported, advance } = harness();
    cb.report({ type: "speech.stopped" });
    advance(300);
    cb.onReplyStarted("r1");
    advance(450);
    cb.onAudioChunk(audio);
    advance(50);
    cb.onAudioChunk(audio);
    cb.report({ type: "reply.completed" });
    expect(inner.onReplyStarted).toHaveBeenCalledWith("r1");
    expect(inner.onAudioChunk).toHaveBeenCalledTimes(2);
    expect(reported.slice(-2)).toEqual([
      { type: "reply.completed" },
      { type: "metrics.collected", interrupted: false, latencyMs: 750 },
    ]);
  });

  test("a silent tool-call reply does not take the turn's mark from the reply that speaks", () => {
    const { cb, advance, frames } = harness();
    cb.report({ type: "speech.stopped" });
    cb.onReplyStarted("tool-reply");
    cb.report({ type: "reply.completed" });
    advance(1200);
    cb.onReplyStarted("answer");
    cb.onAudioChunk(audio);
    cb.report({ type: "reply.completed" });
    expect(frames()).toEqual([
      { type: "metrics.collected", interrupted: false },
      { type: "metrics.collected", interrupted: false, latencyMs: 1200 },
    ]);
  });

  test("a greeting reports no latency, and a cancelled reply is interrupted", () => {
    const { cb, frames } = harness();
    cb.onReplyStarted("greeting");
    cb.onAudioChunk(audio);
    cb.report({ type: "reply.cancelled" });
    expect(frames()).toEqual([{ type: "metrics.collected", interrupted: true }]);
  });

  test("the caller speaking again supersedes an unclaimed end-of-speech", () => {
    const { cb, frames } = harness();
    cb.report({ type: "speech.stopped" });
    cb.report({ type: "speech.started" });
    cb.onReplyStarted("r1");
    cb.onAudioChunk(audio);
    cb.report({ type: "reply.completed" });
    expect(frames()).toEqual([{ type: "metrics.collected", interrupted: false }]);
  });

  test("one frame per reply: a repeated reply.done and a reply with none settle once", () => {
    const { cb, frames } = harness();
    cb.onReplyStarted("r1");
    cb.onReplyStarted("r2");
    cb.report({ type: "reply.completed" });
    cb.report({ type: "reply.completed" });
    expect(frames()).toEqual([
      { type: "metrics.collected", interrupted: true },
      { type: "metrics.collected", interrupted: false },
    ]);
  });
});
