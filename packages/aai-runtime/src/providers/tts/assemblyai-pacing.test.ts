// Copyright 2026 the AAI authors. MIT license.
// AssemblyAI TTS pacing specs: the control-frame budget as the adapter spends
// it, and recovery from the service's pacing close (`3010`).
//
// Observed in a tau2 run (8 sessions, a very fast LLM): ~79 sentence segments
// inside one second, one `Flush` each, then
// `AssemblyAI TTS (3010): Control frame rate exceeded: more than 20
// Flush/KeepAlive/Cancel frames…` and a session that was mute until the caller
// hung up. Documented limit: https://www.assemblyai.com/docs/tts/limits.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TtsError } from "../openers.ts";
import { openSession } from "./_assemblyai-session-test-utils.ts";
import { FakeWebSocket } from "./_fake-ws-test-utils.ts";
import { TTS_PACING_RECOVERY_WINDOW_MS } from "./assemblyai.ts";

const DOCUMENTED_SUSTAINED_PER_SECOND = 20;
const DOCUMENTED_MAX_UNSPOKEN_CHARS = 8000;
const CONTROL_TYPES = new Set(["Flush", "KeepAlive", "Cancel"]);

const PACING_ERROR = {
  type: "Error",
  error_code: 3010,
  error:
    "Control frame rate exceeded: more than 20 Flush/KeepAlive/Cancel frames or empty " +
    "Generates per second sustained. Send control frames only as the conversation needs them.",
  error_type: "input_rate_exceeded",
  retryable: false,
};

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Record the virtual time of every control frame sent on `ws`. */
function recordControlFrames(ws: FakeWebSocket): number[] {
  const at: number[] = [];
  const send = ws.send.bind(ws);
  ws.send = (data: string | Uint8Array) => {
    if (typeof data === "string") {
      const frame = JSON.parse(data) as { type: string };
      if (CONTROL_TYPES.has(frame.type)) at.push(Date.now());
    }
    send(data);
  };
  return at;
}

/**
 * Record what `ws` is sent, as the service would account for it: control
 * frames by virtual time, and characters sent but not yet acknowledged.
 */
function recordWire(ws: FakeWebSocket) {
  const wire = {
    controlAt: [] as number[],
    outstanding: [] as number[],
    pending: 0,
    unspoken: 0,
    maxUnspoken: 0,
    ack() {
      wire.unspoken -= wire.outstanding.shift() ?? 0;
    },
  };
  const send = ws.send.bind(ws);
  ws.send = (data: string | Uint8Array) => {
    if (typeof data === "string") {
      const frame = JSON.parse(data) as { type: string; text?: string };
      if (CONTROL_TYPES.has(frame.type)) wire.controlAt.push(Date.now());
      if (frame.type === "Generate") {
        wire.pending += frame.text?.length ?? 0;
        wire.unspoken += frame.text?.length ?? 0;
        wire.maxUnspoken = Math.max(wire.maxUnspoken, wire.unspoken);
      }
      if (frame.type === "Flush") {
        wire.outstanding.push(wire.pending);
        wire.pending = 0;
      }
    }
    send(data);
  };
  return wire;
}

/** The most control frames in any one-second sliding window. */
function maxPerSecond(times: number[]): number {
  let max = 0;
  for (const [i, start] of times.entries()) {
    const inWindow = times.slice(i).filter((t) => t < start + 1000).length;
    max = Math.max(max, inWindow);
  }
  return max;
}

const flushes = (ws: FakeWebSocket) => ws._frames().filter((f) => f.type === "Flush").length;
const generated = (ws: FakeWebSocket) =>
  ws
    ._frames()
    .filter((f) => f.type === "Generate")
    .map((f) => f.text as string)
    .join("");

/** Acknowledge every flush sent on `ws` so far that has not been acknowledged. */
function ackAll(ws: FakeWebSocket, acked: { n: number }): void {
  while (acked.n < flushes(ws)) {
    ws._msg({ type: "FlushDone" });
    acked.n += 1;
  }
}

/** `n` short sentences, each a segment of its own. */
const sentences = (n: number) => Array.from({ length: n }, (_, i) => `Item ${i} is ready. `);

describe("AssemblyAI TTS control-frame budget", () => {
  test("a burst of short sentences stays under the documented control-frame rate", async () => {
    const { session, ws } = await openSession();
    const times = recordControlFrames(ws);
    const text = sentences(80);
    // ~80 segments in under a second, as observed.
    for (const s of text) {
      session.sendText(s);
      await vi.advanceTimersByTimeAsync(10);
    }
    session.flush();
    await vi.advanceTimersByTimeAsync(5000);

    expect(maxPerSecond(times)).toBeLessThanOrEqual(DOCUMENTED_SUSTAINED_PER_SECOND);
    // Fewer flushes than segments: the backlog was merged, not dropped…
    expect(flushes(ws)).toBeLessThan(text.length);
    // …and every character reached the wire, in order.
    expect(generated(ws)).toBe(text.join(""));
  });

  test("the first segment still flushes immediately", async () => {
    const { session, ws } = await openSession();
    session.sendText("Hello there. ");
    expect(ws._frames()).toEqual([{ type: "Generate", text: "Hello there. " }, { type: "Flush" }]);
  });

  test("a reply's first flush is not delayed by a budget the last reply drained", async () => {
    const { session, ws } = await openSession();
    const acked = { n: 0 };
    // Spend the bucket down to its reserve without letting time pass.
    for (const s of sentences(6)) session.sendText(s);
    session.flush();
    ackAll(ws, acked);
    // The next reply's first segment still goes out synchronously…
    const sent = flushes(ws);
    session.sendText("Brand new reply. ");
    expect(flushes(ws)).toBe(sent + 1);
    // …while its second waits on the budget and goes out once it refills.
    session.sendText("Its second sentence. ");
    expect(flushes(ws)).toBe(sent + 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(flushes(ws)).toBe(sent + 2);
  });

  test("done waits for every merged flush, and for a remainder held by the budget", async () => {
    const { session, ws } = await openSession();
    const done = vi.fn();
    session.on("done", done);
    for (const s of sentences(20)) session.sendText(s);
    session.sendText("and a tail with no end");
    session.flush();
    // Some segments are still waiting on the budget: the turn cannot be over.
    const early = flushes(ws);
    for (let i = 0; i < early; i++) ws._msg({ type: "FlushDone" });
    expect(done).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    const total = flushes(ws);
    expect(total).toBeGreaterThan(early);
    expect(generated(ws)).toBe(`${sentences(20).join("")}and a tail with no end`);
    for (let i = early; i < total - 1; i++) ws._msg({ type: "FlushDone" });
    expect(done).not.toHaveBeenCalled();
    ws._msg({ type: "FlushDone" });
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("cancel discards the backlog, and the Cancel frame never waits on the budget", async () => {
    const { session, ws } = await openSession();
    for (const s of sentences(20)) session.sendText(s);
    const sent = ws._frames().length;
    session.cancel();
    // Sent synchronously although flushes have spent the bucket to its reserve.
    expect(ws._frames().slice(sent)).toEqual([{ type: "Cancel" }]);
    ws._msg({ type: "Cancelled" });
    // The held-back segments never follow it.
    await vi.advanceTimersByTimeAsync(3000);
    expect(ws._frames().slice(sent)).toEqual([{ type: "Cancel" }]);
  });
});

describe("AssemblyAI TTS pacing close (3010)", () => {
  test("is recovered on a new socket instead of ending the session", async () => {
    const { session, ws } = await openSession();
    const errors: TtsError[] = [];
    session.on("error", (e) => errors.push(e));
    const done = vi.fn();
    session.on("done", done);

    session.sendText("First sentence here. ");
    session.sendText("Second sentence here. ");
    session.sendText("Third sentence here. ");
    expect(flushes(ws)).toBe(3);
    ws._msg(PACING_ERROR);
    ws.close(3010);

    expect(errors).toEqual([]);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.latest();
    expect(session._ws).toBe(next);
    // The first flush was mid-synthesis (partly heard), so the reply resumes at
    // the second; the rest is re-sent as ONE flush.
    expect(next._frames()).toEqual([
      { type: "Generate", text: "Second sentence here. Third sentence here. " },
      { type: "Flush" },
    ]);

    session.flush();
    expect(done).not.toHaveBeenCalled();
    next._msg({ type: "FlushDone" });
    expect(done).toHaveBeenCalledTimes(1);

    // The session carries on.
    session.sendText("A later reply. ");
    expect(next._frames().at(-1)).toEqual({ type: "Flush" });
  });

  test("a recovery with a large backlog paces it onto the new socket", async () => {
    // The docs: 3010 also fires past 8000 characters sent but not yet
    // synthesized, and a recovery must not resend the same burst. So the
    // owed text goes through the same budgets as any other.
    const { session, ws } = await openSession();
    const errors: TtsError[] = [];
    session.on("error", (e) => errors.push(e));
    const text = Array.from({ length: 120 }, (_, i) => `Line ${i} ${"word ".repeat(18)}end. `);
    for (const s of text) {
      session.sendText(s);
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    ws._msg(PACING_ERROR);
    const next = FakeWebSocket.latest();
    expect(next).not.toBe(ws);
    const wire = recordWire(next);

    // The service synthesizes and acknowledges at its own pace.
    for (let i = 0; i < 600; i++) {
      await vi.advanceTimersByTimeAsync(100);
      if (i % 3 === 0 && wire.outstanding.length > 0) {
        wire.ack();
        next._msg({ type: "FlushDone" });
      }
    }

    expect(errors).toEqual([]);
    expect(wire.maxUnspoken).toBeLessThanOrEqual(DOCUMENTED_MAX_UNSPOKEN_CHARS);
    expect(maxPerSecond(wire.controlAt)).toBeLessThanOrEqual(DOCUMENTED_SUSTAINED_PER_SECOND);
    // Everything owed arrived, in order (at most the first line was dropped).
    const all = text.join("");
    expect(all.endsWith(generated(next))).toBe(true);
    expect(generated(next).length).toBeGreaterThanOrEqual(all.length - (text[0]?.length ?? 0));
  });

  test("a closed turn whose only flush was mid-synthesis ends on recovery", async () => {
    const { session, ws } = await openSession();
    const done = vi.fn();
    session.on("done", done);
    session.sendText("Only sentence. ");
    session.flush();
    ws._msg(PACING_ERROR);
    expect(done).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.latest()._frames()).toEqual([]);
  });

  test("a bare 3010 close, with no Error frame, is recovered the same way", async () => {
    const { session, ws } = await openSession();
    const errors: TtsError[] = [];
    session.on("error", (e) => errors.push(e));
    ws.close(3010);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("a second pacing close inside the window is fatal", async () => {
    const { session, ws } = await openSession();
    const errors: TtsError[] = [];
    session.on("error", (e) => errors.push(e));
    ws._msg(PACING_ERROR);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([]);

    FakeWebSocket.latest()._msg(PACING_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("tts_stream_error");
    expect(errors[0]?.message).toContain("3010");
  });

  test("another pacing close after the window is recovered again", async () => {
    const { session, ws } = await openSession();
    const errors: TtsError[] = [];
    session.on("error", (e) => errors.push(e));
    ws._msg(PACING_ERROR);
    await vi.advanceTimersByTimeAsync(TTS_PACING_RECOVERY_WINDOW_MS);
    FakeWebSocket.latest()._msg(PACING_ERROR);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  test("any other Error frame stays fatal", async () => {
    const { session, ws } = await openSession();
    const errors: TtsError[] = [];
    session.on("error", (e) => errors.push(e));
    ws._msg({ type: "Error", error_code: 3006, error: "bad frame" });
    expect(errors).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
