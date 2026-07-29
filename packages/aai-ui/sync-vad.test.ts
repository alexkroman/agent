// Copyright 2026 the AAI authors. MIT license.
// Energy-VAD utterance detector state machine.

import { describe, expect, test } from "vitest";
import { createUtteranceDetector } from "./sync-vad.ts";

const RATE = 16_000;

function samplesFor(ms: number): number {
  return (RATE * ms) / 1000;
}

function voiced(ms: number): Int16Array {
  return new Int16Array(samplesFor(ms)).fill(3000); // ~0.09 RMS
}

function silent(ms: number): Int16Array {
  return new Int16Array(samplesFor(ms));
}

function makeDetector(overrides: Record<string, number> = {}) {
  return createUtteranceDetector({
    sampleRate: RATE,
    minSpeechMs: 100,
    hangoverMs: 200,
    prerollMs: 100,
    maxUtteranceMs: 2000,
    ...overrides,
  });
}

/** Push a sequence of frames, returning every emitted utterance. */
function drive(det: ReturnType<typeof makeDetector>, frames: Int16Array[]): Int16Array[] {
  const out: Int16Array[] = [];
  for (const f of frames) {
    const u = det.push(f);
    if (u) out.push(u);
  }
  return out;
}

describe("createUtteranceDetector", () => {
  test("silence alone never emits and never speaks", () => {
    const det = makeDetector();
    expect(drive(det, [silent(100), silent(100), silent(100)])).toEqual([]);
    expect(det.speaking).toBe(false);
    expect(det.flush()).toBeNull();
  });

  test("speech closed by hangover emits one utterance with preroll and tail", () => {
    const det = makeDetector();
    const utterances = drive(det, [
      silent(50), // preroll (within 100ms window)
      voiced(50),
      voiced(50), // 100ms voiced → confirmed
      voiced(100),
      silent(100),
      silent(100), // 200ms silence → close
    ]);
    expect(utterances).toHaveLength(1);
    // Everything pushed since the preroll is included.
    expect(utterances[0]?.length).toBe(samplesFor(450));
    expect(det.speaking).toBe(false);
  });

  test("a short click never becomes an utterance", () => {
    const det = makeDetector();
    expect(drive(det, [voiced(50), silent(50), silent(300)])).toEqual([]);
    expect(det.speaking).toBe(false);
    // ...and real speech afterwards still detects normally.
    const utterances = drive(det, [voiced(50), voiced(50), voiced(100), silent(200)]);
    expect(utterances).toHaveLength(1);
  });

  test("speaking flips true once minSpeechMs is sustained", () => {
    const det = makeDetector();
    det.push(voiced(50));
    expect(det.speaking).toBe(false);
    det.push(voiced(50));
    expect(det.speaking).toBe(true);
  });

  test("maxUtteranceMs force-closes a monologue mid-speech", () => {
    const det = makeDetector({ maxUtteranceMs: 400 });
    const utterances = drive(det, [voiced(100), voiced(100), voiced(100), voiced(100)]);
    expect(utterances).toHaveLength(1);
    expect(det.speaking).toBe(false);
  });

  test("flush returns an in-progress utterance; idle flush returns null", () => {
    const det = makeDetector();
    det.push(voiced(100));
    det.push(voiced(100));
    expect(det.speaking).toBe(true);
    const utterance = det.flush();
    expect(utterance?.length).toBe(samplesFor(200));
    expect(det.flush()).toBeNull();
  });

  test("flush discards an unconfirmed candidate as noise", () => {
    const det = makeDetector();
    det.push(voiced(50)); // below minSpeechMs
    expect(det.flush()).toBeNull();
  });

  test("reset discards buffered audio", () => {
    const det = makeDetector();
    det.push(voiced(100));
    det.push(voiced(100));
    det.reset();
    expect(det.speaking).toBe(false);
    expect(det.flush()).toBeNull();
  });

  test("preroll ring stays bounded during long silence", () => {
    const det = makeDetector();
    for (let i = 0; i < 100; i++) det.push(silent(50));
    const utterances = drive(det, [voiced(50), voiced(50), voiced(100), silent(200)]);
    expect(utterances).toHaveLength(1);
    // preroll (≤100ms) + 200ms speech + 200ms tail — not 5s of silence.
    expect(utterances[0]?.length).toBeLessThanOrEqual(samplesFor(500));
  });

  test("empty frames are ignored", () => {
    const det = makeDetector();
    expect(det.push(new Int16Array(0))).toBeNull();
    expect(det.speaking).toBe(false);
  });
});
