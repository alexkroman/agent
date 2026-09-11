// Copyright 2026 the AAI authors. MIT license.
/**
 * The output path's own specs: the DOUBLE gate, and the one queue audio and
 * word timings share.
 *
 * The speak gate's arithmetic is `pipeline-speak-gate.test.ts`; the transport
 * end-to-end wiring is `pipeline-turn-taking.test.ts`. What is here is what
 * this module adds over both — that the turn's audio gate is checked BEFORE
 * and AGAIN AFTER the hold, and that a held frame's bookkeeping is held with
 * it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_test-utils.ts";
import { createAudioOut } from "./pipeline-audio-out.ts";
import { NO_GUARDRAILS } from "./pipeline-guardrails.ts";
import { createHeardTracker } from "./pipeline-heard.ts";
import { createTurnMachine } from "./pipeline-turn-state.ts";

function makeAudioOut(windows: { floorMs?: number; backoffMs?: number } = {}) {
  const turns = createTurnMachine();
  const heard = createHeardTracker({ sampleRate: 24_000 });
  const chunks: Uint8Array[] = [];
  const sent: string[] = [];
  const audioOut = createAudioOut({
    startSpeakingFloorMs: windows.floorMs ?? 0,
    interruptionBackoffMs: windows.backoffMs ?? 0,
    turns,
    heard,
    tts: () => ({ sendText: (text: string) => sent.push(text) }),
    callbacks: {
      report: () => undefined,
      onAudioChunk: (bytes) => chunks.push(bytes),
    },
    guardrails: NO_GUARDRAILS,
    log: silentLogger,
    sid: "t",
  });
  return { audioOut, turns, heard, chunks, sent };
}

describe("sendTtsText", () => {
  test("REOPENS the turn's audio gate an interrupt closed, so a new turn can be heard", () => {
    const { audioOut, turns, chunks } = makeAudioOut();
    // The gate an aborted turn's late frames hit.
    turns.interrupt();
    audioOut.onTtsAudio(new Int16Array(240));
    expect(chunks).toHaveLength(0);

    audioOut.sendTtsText("hello");
    expect(turns.audioGateOpen()).toBe(true);
    audioOut.onTtsAudio(new Int16Array(240));
    expect(chunks).toHaveLength(1);
  });

  test("ASCII-folds typographic quotes for the engine, length-preserving", () => {
    const { audioOut, sent } = makeAudioOut();
    audioOut.sendTtsText("it’s here");
    expect(sent).toEqual(["it's here"]);
    expect(sent[0]).toHaveLength("it’s here".length);
  });
});

describe("the double gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a frame HELD by the floor is dropped when the turn is interrupted meanwhile", () => {
    const { audioOut, turns, chunks } = makeAudioOut({ floorMs: 400 });
    audioOut.sendTtsText("hello");
    audioOut.armFloor();
    audioOut.onTtsAudio(new Int16Array(240));
    expect(chunks).toHaveLength(0);

    // The turn's own gate closes — the authority on whether a frame is still
    // wanted — and the flush re-checks it rather than trusting the queue.
    turns.interrupt();
    vi.advanceTimersByTime(400);
    expect(chunks).toHaveLength(0);
  });

  test("a held frame's BOOKKEEPING is held with it, so the heard cursor cannot run ahead", () => {
    const { audioOut, heard, chunks } = makeAudioOut({ floorMs: 400 });
    audioOut.sendTtsText("hello there");
    audioOut.armFloor();
    audioOut.onTtsAudio(new Int16Array(24_000));
    // Nothing forwarded and nothing heard: `heard.onAudio` is inside the hold.
    expect(chunks).toHaveLength(0);
    expect(heard.pending()).toBe(false);

    vi.advanceTimersByTime(400);
    expect(chunks).toHaveLength(1);
    expect(heard.pending()).toBe(true);
  });

  test("audio and word timings share ONE queue, in arrival order", () => {
    const { audioOut, heard, chunks } = makeAudioOut({ floorMs: 400 });
    audioOut.sendTtsText("hello there");
    audioOut.armFloor();
    audioOut.onTtsWords([{ text: "hello", startMs: 0, endMs: 100 }]);
    audioOut.onTtsAudio(new Int16Array(240));
    expect(chunks).toHaveLength(0);
    expect(heard.heard().chars).toBe(0);

    vi.advanceTimersByTime(400);
    expect(chunks).toHaveLength(1);
  });

  test("drop() discards the queue; the next turn's audio still flows", () => {
    const { audioOut, chunks } = makeAudioOut({ floorMs: 400 });
    audioOut.sendTtsText("hello");
    audioOut.armFloor();
    audioOut.onTtsAudio(new Int16Array(240));
    audioOut.drop();
    vi.advanceTimersByTime(400);
    expect(chunks).toHaveLength(0);

    audioOut.sendTtsText("second");
    audioOut.onTtsAudio(new Int16Array(240));
    expect(chunks).toHaveLength(1);
  });

  test("with both windows at 0 a frame is forwarded in the same tick", () => {
    const { audioOut, chunks } = makeAudioOut();
    audioOut.sendTtsText("hello");
    audioOut.armFloor();
    audioOut.onTtsAudio(new Int16Array(240));
    expect(chunks).toHaveLength(1);
  });
});
