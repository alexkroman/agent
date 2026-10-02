// Copyright 2026 the AAI authors. MIT license.
/**
 * The playback bench's own parts — the pacer model, the link model, the
 * renderer over the real worklet, and the score.
 *
 * `playback-tuning.test.ts` is the bench's consumer and pins FINDINGS about the
 * worklet's settings; this file pins the instruments those findings are read
 * off, on schedules built by hand so each expected number can be worked out
 * here. The score's ranking over the recorded reply (moved from the tuning
 * suite) is the one case that needs the fixture, and skips without it.
 */

import path from "node:path";
import { describe, expect, test } from "vitest";
import { CLIENT_AUDIO_LEAD_MS, PACER_BURST_MS, PLAYBACK_FILL_MS } from "../types.ts";
import {
  type Delivery,
  type NetworkProfile,
  overNetwork,
  type PacerProfile,
  pacedSends,
  QUANTUM,
  type RenderResult,
  renderSchedule,
  runBench,
  scoreRender,
  toWav,
} from "./_playback-bench-harness.ts";
import { hasTtsTrace, readTtsTraceSync, type TtsTrace } from "./_tts-trace-harness.ts";

const RATE = 24_000;

/** A reply of `count` frames of `ms` each, all arriving at `atMs`. */
function syntheticTrace(count: number, ms: number, atMs = 0): TtsTrace {
  const samplesPerFrame = (RATE * ms) / 1000;
  const pcm = new Int16Array(count * samplesPerFrame).fill(1000);
  const frames = Array.from({ length: count }, (_, i) => ({
    tMs: atMs,
    offset: i * samplesPerFrame * 2,
    length: samplesPerFrame * 2,
  }));
  return {
    sampleRate: RATE,
    provider: "test",
    voice: "test",
    text: "",
    firstAudioMs: atMs,
    doneMs: atMs,
    frames,
    pcm,
  };
}

/** `n` bytes, sent at `atMs`. */
const send = (atMs: number, n = 960): Delivery => ({ atMs, bytes: new Uint8Array(n) });

describe("pacedSends", () => {
  test("with room in the lead, a frame goes out the moment it exists", () => {
    const sends = pacedSends(syntheticTrace(3, 20, 5), { leadMs: 10_000, burstMs: 0 });
    expect(sends.map((s) => s.atMs)).toEqual([5, 5, 5]);
  });

  test("past the lead ceiling a frame waits until a burst has drained", () => {
    // 100 ms frames under a 200 ms lead with a 50 ms burst: three go at once
    // (the lead reaches the ceiling, not past it); the fourth would sit 300 ms
    // ahead of the ear, so it is held until 150 ms of lead remain — at
    // 300 - 150 = 150 ms.
    const sends = pacedSends(syntheticTrace(4, 100), { leadMs: 200, burstMs: 50 });
    expect(sends.map((s) => s.atMs)).toEqual([0, 0, 0, 150]);
  });
});

describe("overNetwork", () => {
  const net = (over: Partial<NetworkProfile> = {}): NetworkProfile => ({
    name: "t",
    latencyMs: 30,
    jitterMs: 0,
    ...over,
  });

  test("adds the link's latency to every send", () => {
    expect(overNetwork([send(0), send(10)], net()).map((d) => d.atMs)).toEqual([30, 40]);
  });

  test("a stall delivers everything it held the moment it ends", () => {
    const out = overNetwork(
      [send(0), send(50), send(200)],
      net({ stalls: [{ atMs: 60, forMs: 100 }] }),
    );
    expect(out.map((d) => d.atMs)).toEqual([30, 160, 230]);
  });

  test("a bitrate ceiling serializes the sends behind each other", () => {
    // 960 bytes at 384 kbps is 20 ms on the wire.
    const out = overNetwork([send(0), send(0)], net({ latencyMs: 0, bitsPerSecond: 384_000 }));
    expect(out.map((d) => d.atMs)).toEqual([20, 40]);
  });

  test("jitter is deterministic and bounded, and the result is in arrival order", () => {
    const sends = Array.from({ length: 50 }, (_, i) => send(i * 20));
    const first = overNetwork(sends, net({ jitterMs: 40 }));
    expect(overNetwork(sends, net({ jitterMs: 40 }))).toEqual(first);
    for (const [i, d] of first.entries()) {
      if (i > 0) expect(d.atMs).toBeGreaterThanOrEqual(first[i - 1]?.atMs ?? 0);
    }
    expect(Math.max(...first.map((d, i) => d.atMs - (sends[i]?.atMs ?? 0)))).toBeLessThan(
      30 + 40 + 20 * 50,
    );
  });
});

describe("renderSchedule", () => {
  test("a reply delivered whole renders every sample and conceals none", () => {
    const trace = syntheticTrace(10, 20);
    const deliveries = pacedSends(trace, { leadMs: 10_000, burstMs: 0 });
    const r = renderSchedule(deliveries, { sampleRate: RATE, settings: { fillMs: 100 } });

    expect(r.stats.concealedSamples).toBe(0);
    // 200 ms of audio, played out whole, to within one render quantum.
    const quantumMs = (QUANTUM / RATE) * 1000;
    expect(r.playedMs).toBeGreaterThanOrEqual(200 - quantumMs);
    expect(r.playedMs).toBeLessThanOrEqual(200 + quantumMs);
    expect(r.gapsMs).toEqual([]);
    expect(r.timeToFirstAudioMs).toBeGreaterThanOrEqual(0);
  });

  test("a reply cut in two by a long gap conceals the gap", () => {
    const trace = syntheticTrace(2, 100);
    const [a, b] = pacedSends(trace, { leadMs: 10_000, burstMs: 0 });
    if (!(a && b)) throw new Error("expected two sends");
    const r = renderSchedule([a, { ...b, atMs: 1000 }], {
      sampleRate: RATE,
      settings: { fillMs: 50 },
    });
    expect(r.stats.concealedSamples).toBeGreaterThan(0);
    expect(r.stats.concealmentEvents).toBeGreaterThan(0);
  });
});

describe("scoreRender", () => {
  /** A render with only the fields the score reads. */
  function render(over: Partial<RenderResult["stats"]> & { firstMs?: number }): RenderResult {
    const { firstMs = 0, ...stats } = over;
    return {
      rendered: new Float32Array(0),
      sampleRate: RATE,
      timeToFirstAudioMs: firstMs,
      stats: {
        concealedSamples: 0,
        silentConcealedSamples: 0,
        concealmentEvents: 0,
        silentConcealmentEvents: 0,
        ...stats,
      },
      gapsMs: [],
      progressMs: [],
      earMs: [],
      playedMs: 0,
    };
  }

  test("weighs startup once, a concealed ms twice, a SILENT ms twenty times, an episode 50", () => {
    // 240 concealed samples at 24 kHz is 10 ms, of which 120 (5 ms) silent.
    const { score, parts } = scoreRender(
      render({
        firstMs: 100,
        concealedSamples: 240,
        silentConcealedSamples: 120,
        concealmentEvents: 1,
      }),
    );
    expect(parts).toEqual({ startupMs: 100, concealedMs: 5, silentMs: 5, events: 1 });
    expect(score).toBe(100 + 5 * 2 + 5 * 20 + 50);
  });
});

describe("toWav", () => {
  test("is a 16-bit mono PCM WAV of the samples, clamped", () => {
    const wav = toWav(new Float32Array([0, 1, -1, 2]), RATE);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(RATE);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect([0, 1, 2, 3].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([
      0, 32_767, -32_767, 32_767,
    ]);
  });
});

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const TRACE = "tts-reply-24k";

/** Production's pacing — the REAL constants, as the tuning suite uses them. */
const SHIPPED_PACER: PacerProfile = {
  leadMs: CLIENT_AUDIO_LEAD_MS,
  burstMs: PACER_BURST_MS,
};
const SHIPPED = { fillMs: PLAYBACK_FILL_MS };
const TYPICAL: NetworkProfile = { name: "typical", latencyMs: 30, jitterMs: 40 };

const stall = (atMs: number, forMs: number): NetworkProfile => ({
  name: `stall-${forMs}`,
  latencyMs: 30,
  jitterMs: 40,
  stalls: [{ atMs, forMs }],
});

describe.skipIf(!hasTtsTrace(FIXTURES, TRACE))("scoring the recorded reply", () => {
  const trace = readTtsTraceSync(FIXTURES, TRACE);

  test("the score ranks a clean render above a stalled one", () => {
    // The weights in `scoreRender` are the bench's one opinion; this keeps them
    // from silently inverting, which would quietly re-rank every sweep above.
    const clean = scoreRender(
      runBench({ trace, pacer: SHIPPED_PACER, net: TYPICAL, settings: SHIPPED }),
    );
    // Past what the shipped lead absorbs — otherwise there is no stall to rank.
    const stalled = scoreRender(
      runBench({
        trace,
        pacer: SHIPPED_PACER,
        net: stall(3000, SHIPPED_PACER.leadMs + 1000),
        settings: SHIPPED,
      }),
    );
    expect(clean.score).toBeLessThan(stalled.score);
    expect(clean.parts.silentMs).toBe(0);
    expect(stalled.parts.silentMs).toBeGreaterThan(0);
  });
});
