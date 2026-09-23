// Copyright 2026 the AAI authors. MIT license.
// Wired-up specs for the heard-history cut: a barge-in that lands AFTER the
// turn body committed its whole reply — during the TTS drain, in the client's
// playback tail, or during the next (chained) reply — still leaves history
// holding only what the caller heard. The truncation itself is unit-specced in
// pipeline-heard-history.test.ts; the aborted-body case in
// pipeline-transport-barge-in.test.ts.

import { describe, expect, test, vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeTtsProvider,
  createTestClock,
  type ScriptedPart,
  speakFor,
} from "../_pipeline-test-fakes.ts";
import { silentLogger } from "../runtime-config.ts";
import { llmCalls, makeOpts, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

const REPLY =
  "Your refund of forty dollars goes back to the Visa card ending in four two, " +
  "and it should arrive within five business days. Is there anything else?";
const text = (t: string): ScriptedPart[] => [{ type: "text", text: t }];
/** The marked prefix the prompt records for an interrupted reply, or "". */
const recordedPrefix = (prompt: string): string =>
  prompt.match(/"text":"([^"]*) \[interrupted\]"/)?.[1] ?? "";

/**
 * A transport whose replies are `steps`, on a hand-driven heard clock with no
 * ear-lag, a one-word barge-in threshold, and TTS `done` driven by the spec.
 */
async function start(steps: ScriptedPart[][], minBargeInWords = 1) {
  const clock = createTestClock();
  const info = vi.fn();
  const tts = createFakeTtsProvider({ autoDoneOnFlush: false });
  const { opts, stt, callbacks } = makeOpts(
    {
      heardLagMs: 0,
      heardNow: clock.now,
      minBargeInWords,
      logger: { ...silentLogger, info },
      llm: createFakeLanguageModel({ steps }),
    },
    { tts },
  );
  const t = createPipelineTransport(opts);
  await t.start();
  const llm = llmCalls(opts);
  /** The prompt of LLM call `n` (1-based), once it has been made. */
  async function promptOf(n: number): Promise<string> {
    await vi.waitFor(() => {
      if (llm.calls.length < n) throw new Error(`LLM call ${n} not made yet`);
    });
    return JSON.stringify(llm.calls[n - 1]?.prompt);
  }
  /** The body committed the reply and the drain is waiting on TTS `done`. */
  async function draining(): Promise<void> {
    await vi.waitFor(() => {
      if (!tts.last()?.flush.mock.calls.length) throw new Error("not draining yet");
    });
  }
  const truncations = (): number =>
    info.mock.calls.filter(([msg]) => msg === "Pipeline heard-history truncated").length;
  return { t, stt, tts, clock, callbacks, promptOf, draining, truncations };
}

describe("PipelineTransport — a cut after the reply was committed", () => {
  test("a barge-in during the TTS drain records only the heard prefix", async () => {
    const s = await start([text(REPLY), text("Sure.")]);
    s.stt.last()?.fireFinal("where is my refund");
    await s.draining();
    // Four seconds synthesized into the client's buffer, one of them played.
    speakFor(s.tts, s.clock, 4000, 1000);
    s.stt.last()?.firePartial("wait");
    s.stt.last()?.fireFinal("wait what card");

    const prompt = await s.promptOf(2);
    const recorded = recordedPrefix(prompt);
    expect(recorded.length).toBeGreaterThan(0);
    expect(REPLY.startsWith(recorded)).toBe(true);
    expect(recorded.length).toBeLessThan(REPLY.length / 2);
    expect(prompt).not.toContain("five business days");
    expect(s.truncations()).toBe(1);
    await s.t.stop();
  });

  test("a barge-in on the playback tail after the turn settled does the same", async () => {
    const s = await start([text(REPLY), text("Sure.")]);
    s.stt.last()?.fireFinal("where is my refund");
    await s.draining();
    speakFor(s.tts, s.clock, 4000, 0);
    s.tts.last()?.emitter.emit("done");
    await vi.waitFor(() => {
      expect(s.callbacks.reported("reply.completed")).toHaveBeenCalled();
    });
    // The turn is over server-side; the client is still playing it out.
    s.clock.advance(1000);
    s.stt.last()?.firePartial("wait");
    expect(s.callbacks.reported("reply.cancelled")).toHaveBeenCalled();
    s.stt.last()?.fireFinal("wait what card");

    const prompt = await s.promptOf(2);
    const recorded = recordedPrefix(prompt);
    expect(recorded.length).toBeGreaterThan(0);
    expect(REPLY.startsWith(recorded)).toBe(true);
    expect(prompt).not.toContain("five business days");
    expect(s.truncations()).toBe(1);
    await s.t.stop();
  });

  test("a reply still playing when a chained turn starts is cut though it is not the latest", async () => {
    // Three words to barge in, so the one-word "okay" is answered rather than
    // interrupting — the chained turn starts while the first reply plays out.
    const long = Array.from({ length: 100 }, (_, i) => ({ type: "text" as const, text: `w${i} ` }));
    const s = await start([text(REPLY), long, text("Sure.")], 3);
    s.stt.last()?.fireFinal("where is my refund");
    await s.draining();
    speakFor(s.tts, s.clock, 4000, 0);
    s.tts.last()?.emitter.emit("done");
    await vi.waitFor(() => {
      expect(s.callbacks.reported("reply.completed")).toHaveBeenCalled();
    });
    s.clock.advance(1000);
    s.stt.last()?.fireFinal("okay");
    await s.promptOf(2);
    s.stt.last()?.firePartial("no wait stop");
    s.stt.last()?.fireFinal("no wait stop");

    const prompt = await s.promptOf(3);
    const recorded = recordedPrefix(prompt);
    expect(recorded.length).toBeGreaterThan(0);
    expect(REPLY.startsWith(recorded)).toBe(true);
    expect(prompt).not.toContain("five business days");
    await s.t.stop();
  });

  test("a reply that played out in full is untouched by a barge-in on a different reply", async () => {
    const long = Array.from({ length: 100 }, (_, i) => ({ type: "text" as const, text: `w${i} ` }));
    const s = await start([text(REPLY), long, text("Sure.")]);
    s.stt.last()?.fireFinal("where is my refund");
    await s.draining();
    // Synthesized AND played before the caller says anything.
    speakFor(s.tts, s.clock, 4000, 6000);
    s.tts.last()?.emitter.emit("done");
    await vi.waitFor(() => {
      expect(s.callbacks.reported("reply.completed")).toHaveBeenCalled();
    });
    s.stt.last()?.fireFinal("and my balance");
    await vi.waitFor(() => {
      expect((s.tts.last()?.textChunks ?? []).join("")).toContain("w1");
    });
    speakFor(s.tts, s.clock, 2000, 500);
    s.stt.last()?.firePartial("stop");
    s.stt.last()?.fireFinal("stop please");

    const prompt = await s.promptOf(3);
    // The earlier reply is recorded whole, unmarked; only the one cut is marked.
    expect(prompt).toContain(`"text":"${REPLY}"`);
    expect(recordedPrefix(prompt)).toMatch(/^w0 /);
    await s.t.stop();
  });
});
