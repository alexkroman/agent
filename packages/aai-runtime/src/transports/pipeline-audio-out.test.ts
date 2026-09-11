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
 *
 * It also owns the RAW SEND's own claims, which arrived from a second
 * extraction of the same code. Two branches independently pulled this send out
 * of `pipeline-transport.ts` — this module and a `pipeline-tts-send.ts` whose
 * `send` body was logically identical — and the integration kept this one,
 * being a strict superset (the send, the guardrail funnel, both TTS handlers
 * AND the speak gate). Keeping both would have meant two places all speech
 * goes through, which is the one property either module exists to make true.
 * The duplicate's unique cases were ported here rather than deleted with it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeLogger } from "../_test-utils.ts";
import { createAudioOut } from "./pipeline-audio-out.ts";
import { NO_GUARDRAILS } from "./pipeline-guardrails.ts";
import { createHeardTracker } from "./pipeline-heard.ts";
import { createTurnMachine } from "./pipeline-turn-state.ts";

function makeAudioOut(
  windows: { floorMs?: number; backoffMs?: number } = {},
  opts: { tts?: () => { sendText(text: string): void } | null } = {},
) {
  const turns = createTurnMachine();
  const heard = createHeardTracker({ sampleRate: 24_000, lagMs: 0 });
  const chunks: Uint8Array[] = [];
  const sent: string[] = [];
  const reported: { type: string; text?: string }[] = [];
  const log = makeLogger();
  const audioOut = createAudioOut({
    startSpeakingFloorMs: windows.floorMs ?? 0,
    interruptionBackoffMs: windows.backoffMs ?? 0,
    turns,
    heard,
    tts: opts.tts ?? (() => ({ sendText: (text: string) => sent.push(text) })),
    callbacks: {
      report: (event) => reported.push(event as { type: string; text?: string }),
      onAudioChunk: (bytes) => chunks.push(bytes),
    },
    guardrails: NO_GUARDRAILS,
    log,
    sid: "t",
  });
  return { audioOut, turns, heard, chunks, sent, reported, log };
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

  // ─── The raw send's other three claims ──────────────────────────────────
  //
  // These came from `pipeline-tts-send.test.ts`, the spec for a second
  // extraction of this same send that the integration collapsed into this
  // module (see this file's module doc). They were previously made only
  // through a whole transport, and they are kept here rather than dropped
  // with the duplicate module.

  test("publishes the interim caption by default, with the tail as it grows", () => {
    const { audioOut, reported } = makeAudioOut();
    audioOut.sendTtsText("Hello. ");
    audioOut.sendTtsText("How are you?");
    expect(reported).toEqual([
      { type: "agent-transcript.updated", text: "Hello. " },
      { type: "agent-transcript.updated", text: "Hello. How are you?" },
    ]);
  });

  test("`publishTranscript: false` skips the caption and still advances the tail", () => {
    // The greeting and the start-failure line publish their own final.
    const { audioOut, reported, heard } = makeAudioOut();
    audioOut.sendTtsText("Welcome.", { publishTranscript: false });
    expect(reported).toEqual([]);
    audioOut.sendTtsText("Anything else?");
    expect(reported).toEqual([
      { type: "agent-transcript.updated", text: "Welcome.Anything else?" },
    ]);
    // The tail is the cursor's, so the skipped line is still part of what the
    // caller heard — which is what feeds the tail-resume estimate.
    expect(heard.spokeRecordable()).toBe(true);
  });

  test("`record: false` marks filler, which the heard cursor refuses to record", () => {
    const { audioOut, heard } = makeAudioOut();
    audioOut.sendTtsText("One moment.", { record: false });
    // Audible — it moved the cursor — and not recordable, the flag the
    // barge-in gate reads.
    expect(heard.spokeRecordable()).toBe(false);
  });

  test("a session with no TTS session yet still advances the cursor", () => {
    // `providers.tts` is null before `open()` and after a recovery, which is
    // why the send reads it through a thunk per send.
    const { audioOut, heard } = makeAudioOut({}, { tts: () => null });
    expect(() => audioOut.sendTtsText("Hello.")).not.toThrow();
    expect(heard.spokeRecordable()).toBe(true);
  });
});

describe("the `TTS first audio` measurement", () => {
  test("is logged ONCE per reply, timed from the first send", () => {
    const { audioOut, log } = makeAudioOut();
    audioOut.sendTtsText("Hello.");
    audioOut.sendTtsText("More.");
    audioOut.onTtsAudio(new Int16Array(240));
    audioOut.onTtsAudio(new Int16Array(240));
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("TTS first audio", expect.objectContaining({ sid: "t" }));
  });

  test("audio arriving before any send says nothing", () => {
    const { audioOut, log } = makeAudioOut();
    audioOut.onTtsAudio(new Int16Array(240));
    expect(log.info).not.toHaveBeenCalled();
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
