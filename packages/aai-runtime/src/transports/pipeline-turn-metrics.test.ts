// Copyright 2026 the AAI authors. MIT license.
// The per-reply `metrics.collected` frame. Two halves, like every transport
// spec in this directory: the recorder's own rules (what each stage measures,
// what "absent" means, which reply a mark belongs to), driven on a hand clock;
// and the wiring through the transport, asserted on what was REPORTED.

import { describe, expect, test, vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeTtsProvider,
  createTestClock,
} from "../_pipeline-test-fakes.ts";
import { createUsageMeter } from "../usage-meter.ts";
import { makeOpts, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";
import type { MetricsCollectedBody } from "./pipeline-turn-metrics.ts";
import { createTurnMetrics } from "./pipeline-turn-metrics.ts";

describe("createTurnMetrics", () => {
  test("a caller turn: endpointing, the model, TTS, and the latency across them", () => {
    const clock = createTestClock();
    const usage = createUsageMeter({ limits: undefined, onUpdate: undefined });
    usage.record({ inputTokens: 500, outputTokens: 10, totalTokens: 510 });
    const m = createTurnMetrics({ usage, now: clock.now });

    m.onPartial();
    clock.advance(300);
    m.onFinal("what time is it");
    clock.advance(5);
    m.begin();
    m.claimTurn("what time is it");
    usage.record({ inputTokens: 900, outputTokens: 30, totalTokens: 930 });
    m.onLlm({ firstPartMs: 480.4, totalMs: 1300, steps: 1 });
    m.onTtsText("Sure, ");
    m.onTtsText("one moment.");
    clock.advance(600);
    m.onFirstAudio(66);
    // Only the FIRST audio of a reply is its TTFB.
    m.onFirstAudio(999);

    expect(m.finish(false)).toEqual({
      type: "metrics.collected",
      interrupted: false,
      latencyMs: 605,
      stt: { endpointingMs: 300 },
      // Tokens are the DELTA across the reply, not the session's running total.
      llm: { ttftMs: 480, durationMs: 1300, steps: 1, inputTokens: 900, outputTokens: 30 },
      tts: { ttfbMs: 66, characters: 17 },
    });
  });

  test("a greeting has no caller turn: no STT stage and no latency", () => {
    const m = createTurnMetrics({ now: createTestClock().now });
    m.begin();
    m.onTtsText("Hello!");
    m.onFirstAudio(70);
    expect(m.finish(false)).toEqual({
      type: "metrics.collected",
      interrupted: false,
      tts: { ttfbMs: 70, characters: 6 },
    });
  });

  test("a committed turn's marks are CLAIMED by one reply, never reused", () => {
    const m = createTurnMetrics({ now: createTestClock().now });
    m.onPartial();
    m.onFinal("yes");
    m.begin();
    m.claimTurn("yes");
    expect(m.finish(false)?.stt).toBeDefined();
    m.begin();
    m.claimTurn("yes");
    expect(m.finish(false)?.stt).toBeUndefined();
  });

  test("two turns queued behind a speaking agent each get their OWN marks", () => {
    // Both finals land before either reply starts; the next reply to begin
    // must not take the newer one's timing.
    const clock = createTestClock();
    const m = createTurnMetrics({ now: clock.now });
    m.onPartial();
    clock.advance(200);
    m.onFinal("first");
    clock.advance(1000);
    m.onPartial();
    clock.advance(700);
    m.onFinal("second");
    clock.advance(3000);
    m.begin();
    m.claimTurn("first");
    expect(m.finish(false)?.stt).toEqual({ endpointingMs: 200 });
    m.begin();
    m.claimTurn("second");
    expect(m.finish(false)?.stt).toEqual({ endpointingMs: 700 });
  });

  test("a turn nobody answered does not lend its marks to a later nudge", () => {
    // A reset dropped the turn; the silence nudge that follows answers other
    // text, so it claims nothing and reports no caller turn.
    const m = createTurnMetrics({ now: createTestClock().now });
    m.onFinal("dropped by reset");
    m.begin();
    m.claimTurn("(the caller has gone quiet — check in)");
    expect(m.finish(false)?.stt).toBeUndefined();
    // Nor does a greeting-shaped reply, which claims nothing at all.
    m.begin();
    expect(m.finish(false)?.stt).toBeUndefined();
  });

  test("a partial from an utterance that ended with no final is not endpointing", () => {
    // A cough: partial, then the edge closes quietly. The next final arrives
    // with no partial of its own and must report no figure, not minutes.
    const clock = createTestClock();
    const m = createTurnMetrics({ now: clock.now });
    m.onPartial();
    m.onUtteranceEnded();
    clock.advance(120_000);
    m.onFinal("hello");
    m.begin();
    m.claimTurn("hello");
    expect(m.finish(false)?.stt).toEqual({});
  });

  test("a final with no partial before it commits a turn with no endpointing figure", () => {
    const m = createTurnMetrics({ now: createTestClock().now });
    m.onFinal("ok");
    m.begin();
    m.claimTurn("ok");
    expect(m.finish(false)?.stt).toEqual({});
  });

  test("an interrupted reply that never spoke still reports what it spent", () => {
    const m = createTurnMetrics({ now: createTestClock().now });
    m.onFinal("ok");
    m.begin();
    m.claimTurn("ok");
    m.onLlm({ totalMs: 200, steps: 0 });
    // No meter on this session: no token fields rather than zeroes.
    expect(m.finish(true)).toEqual({
      type: "metrics.collected",
      interrupted: true,
      stt: {},
      llm: { durationMs: 200, steps: 0 },
    });
  });

  test("a mark with no reply open is dropped, and finish without begin is nothing", () => {
    const m = createTurnMetrics({ now: createTestClock().now });
    m.onTtsText("stray");
    m.onFirstAudio(10);
    m.onLlm({ totalMs: 1, steps: 1 });
    expect(m.finish(false)).toBeUndefined();
    m.begin();
    expect(m.finish(false)).toEqual({ type: "metrics.collected", interrupted: false });
  });
});

describe("PipelineTransport — metrics.collected", () => {
  useVirtualTime();

  test("a caller turn reports one frame per reply, after reply.completed", async () => {
    const tts = createFakeTtsProvider({ autoDoneOnFlush: false });
    const { opts, stt, callbacks } = makeOpts(
      { llm: createFakeLanguageModel({ script: [{ type: "text", text: "Sure thing." }] }) },
      { tts },
    );
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial("what time");
    await vi.advanceTimersByTimeAsync(250);
    stt.last()?.firePartial("what time is it");
    await vi.advanceTimersByTimeAsync(400);
    stt.last()?.fireFinal("what time is it");
    await vi.waitFor(() => expect(tts.last()?.textChunks.join("")).toBe("Sure thing."));
    await vi.advanceTimersByTimeAsync(50);
    tts.last()?.fireAudio(new Int16Array(160));
    tts.last()?.emitter.emit("done");
    await vi.waitFor(() => expect(callbacks.reported("metrics.collected")).toHaveBeenCalled());

    const frame = callbacks.reported("metrics.collected").mock.calls[0]?.[0] as
      | MetricsCollectedBody
      | undefined;
    expect(frame).toMatchObject({
      type: "metrics.collected",
      interrupted: false,
      stt: { endpointingMs: 400 },
      llm: { steps: 1 },
      tts: { characters: "Sure thing.".length },
    });
    expect(frame?.latencyMs).toBeGreaterThanOrEqual(50);
    expect(frame?.tts?.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(frame?.llm?.ttftMs).toBeGreaterThanOrEqual(0);

    const order = callbacks.events
      .map((event) => event.type)
      .filter((type) => type === "reply.completed" || type === "metrics.collected");
    expect(order).toEqual(["reply.completed", "metrics.collected"]);
    await t.stop();
  });

  test("a reply aborted before its first audio does not start the next reply's TTS clock", async () => {
    const tts = createFakeTtsProvider({ autoDoneOnFlush: false });
    const { opts, stt, callbacks } = makeOpts(
      {
        llm: createFakeLanguageModel({
          steps: [[{ type: "text", text: "Let me see." }], [{ type: "text", text: "Here it is." }]],
        }),
      },
      { tts },
    );
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("first question");
    await vi.waitFor(() => expect(tts.last()?.textChunks.join("")).toContain("Let me see."));
    // Cut off before any audio arrived for it.
    t.cancelReply();
    await vi.advanceTimersByTimeAsync(10_000);
    stt.last()?.fireFinal("second question");
    await vi.waitFor(() => expect(tts.last()?.textChunks.join("")).toContain("Here it is."));
    await vi.advanceTimersByTimeAsync(40);
    tts.last()?.fireAudio(new Int16Array(160));
    tts.last()?.emitter.emit("done");
    await vi.waitFor(() =>
      expect(
        callbacks.events.filter((e) => e.type === "metrics.collected" && !e.interrupted),
      ).toHaveLength(1),
    );
    const frame = callbacks.events.find((e) => e.type === "metrics.collected" && !e.interrupted) as
      | MetricsCollectedBody
      | undefined;
    // Measured from THIS reply's text (~40 ms), not the aborted one's (~10 s).
    expect(frame?.tts?.ttfbMs).toBeLessThan(1000);
    await t.stop();
  });

  test("the greeting reports a TTS-only frame", async () => {
    const { opts, callbacks } = makeOpts({
      sessionConfig: { systemPrompt: "s", greeting: "Hi there." },
    });
    const t = createPipelineTransport(opts);
    await t.start();
    await vi.waitFor(() => expect(callbacks.reported("metrics.collected")).toHaveBeenCalled());
    const frame = callbacks.reported("metrics.collected").mock.calls[0]?.[0] as
      | MetricsCollectedBody
      | undefined;
    expect(frame?.stt).toBeUndefined();
    expect(frame?.llm).toBeUndefined();
    expect(frame?.tts?.characters).toBe("Hi there.".length);
    await t.stop();
  });
});
