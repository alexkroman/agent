// Copyright 2026 the AAI authors. MIT license.
/**
 * What the playback jitter buffer's settings actually buy, measured against a
 * RECORDED reply rather than a generated arrival pattern.
 *
 * Every other test of this worklet supplies its own timing.
 * `playback-processor.test.ts` hand-feeds quanta to reach a named branch, and
 * `audio-stress.test.ts` records in its own header that its chunk sizes outrun
 * the render loop by an order of magnitude so the buffer "effectively never
 * starves". Both are the right tests for what they check, and neither can
 * answer "is `PLAYBACK_JITTER_MS` = 400 the right number", because neither has
 * ever seen how TTS audio really arrives.
 *
 * `fixtures/tts-reply-24k.{json,pcm}` is one real AssemblyAI reply — the bytes
 * and the millisecond each frame arrived (`_tts-trace-harness.ts` captured it).
 * Replayed through the server's pacing and a link profile into the real
 * worklet, that turns each setting into a number.
 *
 * **These tests pin FINDINGS, not just behaviour.** Each one exists because it
 * contradicts something the constants' own docs claim, and would fail if a
 * later change made the claim true again — which is the point: a tuning
 * decision that rests on a wrong model of the audio path should break loudly
 * when the model is checked.
 *
 * Cross-validated in a real browser (Chromium, a real `AudioContext` at 24 kHz,
 * a tap node capturing what reached the destination): concealed milliseconds
 * agreed with this renderer within 1-9% and episode counts agreed exactly on
 * eleven of twelve profile/setting cells. `_playback-bench-page.ts` is that
 * harness, so the check is repeatable rather than a claim.
 */

import path from "node:path";
import { describe, expect, test } from "vitest";
import { PLAYBACK_FILL_MS } from "../types.ts";
import {
  type NetworkProfile,
  type PacerProfile,
  runBench,
  scoreRender,
} from "./_playback-bench-harness.ts";
import {
  hasTtsTrace,
  readTtsTraceSync,
  type TtsTrace,
  traceAudioMs,
} from "./_tts-trace-harness.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const TRACE = "tts-reply-24k";

/**
 * Production's pacing, spelled here because `CLIENT_AUDIO_LEAD_MS` and
 * `PACER_BURST_MS` are not on any published subpath — this package cannot
 * import them, which is itself part of what these tests are about (the two
 * numbers that decide the client's cushion are invisible to the client).
 */
const SHIPPED_PACER: PacerProfile = { leadMs: 1000, burstMs: 200 };
const SHIPPED = { fillMs: PLAYBACK_FILL_MS };

const PERFECT: NetworkProfile = { name: "perfect", latencyMs: 0, jitterMs: 0 };
const TYPICAL: NetworkProfile = { name: "typical", latencyMs: 30, jitterMs: 40 };
const MOBILE: NetworkProfile = { name: "mobile", latencyMs: 80, jitterMs: 150 };
/** Below the 384 kbps that 24 kHz PCM16 needs — no buffer can fix this link. */
const STARVED: NetworkProfile = {
  name: "starved-350k",
  latencyMs: 40,
  jitterMs: 40,
  bitsPerSecond: 350_000,
};
/** Where the stall probes freeze the link: mid-reply, past the ramp-up. */
const STALL_AT_MS = 4000;

const stall = (atMs: number, forMs: number): NetworkProfile => ({
  name: `stall-${forMs}`,
  latencyMs: 30,
  jitterMs: 40,
  stalls: [{ atMs, forMs }],
});

/** The longest freeze the chain absorbs with no concealment at all. */
function absorbedStallMs(opts: {
  trace: TtsTrace;
  pacer: PacerProfile;
  settings: { fillMs: number };
  atMs?: number;
  /** Search ceiling. The unpaced case rides out an unbounded freeze, so a
   * ceiling sized for the shipped lead would report the ceiling as the answer. */
  maxMs?: number;
}): number {
  let lo = 0;
  let hi = opts.maxMs ?? 4000;
  while (hi - lo > 25) {
    const mid = (lo + hi) / 2;
    const r = runBench({
      trace: opts.trace,
      pacer: opts.pacer,
      net: stall(opts.atMs ?? STALL_AT_MS, mid),
      settings: opts.settings,
    });
    if (r.stats.concealedSamples === 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

const present = hasTtsTrace(FIXTURES, TRACE);
if (!present) {
  console.warn(
    `[playback-tuning] fixtures/${TRACE}.{json,pcm} is missing — SKIPPING every ` +
      "tuning measurement. Re-capture it with `captureTtsTrace` (see " +
      "`_tts-trace-harness.ts`); a silent skip here means the jitter buffer's " +
      "settings are pinned by nothing.",
  );
}

describe.skipIf(!present)("playback tuning against a real TTS reply", () => {
  const trace = readTtsTraceSync(FIXTURES, TRACE);
  const rate = trace.sampleRate;
  const asMs = (samples: number): number => (samples / rate) * 1000;

  test("the recorded reply arrives far faster than it plays, so the provider is not the jitter source", () => {
    // 8 s of speech delivered in under half a second. This is the fact the rest
    // of the file rests on: a jitter buffer sized against provider unevenness is
    // sized against nothing, because there is none — the arrival pattern the
    // client sees is manufactured by the server's pacer.
    const audioMs = traceAudioMs(trace);
    expect(audioMs).toBeGreaterThan(6000);
    expect(trace.doneMs).toBeLessThan(audioMs / 5);
    expect(trace.firstAudioMs).toBeLessThan(250);
  });

  test("a healthy link conceals nothing and starts speaking well inside the fill target", () => {
    for (const net of [PERFECT, TYPICAL, MOBILE]) {
      const r = runBench({ trace, pacer: SHIPPED_PACER, net, settings: SHIPPED });
      expect.soft(r.stats.concealedSamples, `${net.name} concealed`).toBe(0);
      expect.soft(r.stats.concealmentEvents, `${net.name} episodes`).toBe(0);
      // The fill target is paid in well under its own duration of wall clock,
      // because the audio to fill it with has already arrived — TTS outruns
      // playback ~20x, so the buffer is never waiting on synthesis.
      expect
        .soft(r.timeToFirstAudioMs, `${net.name} time to first audio`)
        .toBeLessThan(PLAYBACK_FILL_MS * 2);
    }
  });

  test("nothing is ever lost: rendered audio is the reply plus exactly what was concealed", () => {
    // The integrity property `audio-stress.test.ts` proves for generated input,
    // asserted here on the real thing — and it is what makes a duration
    // comparison a legitimate quality metric elsewhere in this file.
    const r = runBench({ trace, pacer: SHIPPED_PACER, net: stall(3000, 1500), settings: SHIPPED });
    const renderedMs = (r.rendered.length / rate) * 1000;
    const expectedMs = traceAudioMs(trace) + asMs(r.stats.concealedSamples);
    // Within one render quantum plus the startup gate.
    expect(renderedMs).toBeGreaterThanOrEqual(expectedMs - 10);
    expect(renderedMs).toBeLessThanOrEqual(expectedMs + r.timeToFirstAudioMs + 10);
  });

  test("the one fill target may not go LOWER: it is the anti-stutter re-arm", () => {
    // `PLAYBACK_FILL_MS` survived the collapse of the two targets because of
    // this: on a link under the PCM bitrate it is the difference between a few
    // audible pauses and a fragment per render quantum, which is the failure the
    // re-arm was added for. The startup target that was deleted had no such job.
    const shipped = runBench({ trace, pacer: SHIPPED_PACER, net: STARVED, settings: SHIPPED });
    const stuttering = runBench({
      trace,
      pacer: SHIPPED_PACER,
      net: STARVED,
      settings: { fillMs: 25 },
    });
    expect(stuttering.stats.concealmentEvents).toBeGreaterThan(shipped.stats.concealmentEvents * 3);
    // Same lost audio, chopped far finer — no gap long enough to read as a pause.
    expect(Math.max(0, ...stuttering.gapsMs)).toBeLessThan(Math.max(0, ...shipped.gapsMs));
  });

  test("a deeper fill target trades startup for smoothness ONLY under starvation", () => {
    // The whole remaining tuning range of this constant, and why 200 sits where
    // it does. On any link that can carry 384 kbps the target is invisible; below
    // it, more cushion means fewer, longer holes and a later start.
    const shallow = runBench({
      trace,
      pacer: SHIPPED_PACER,
      net: STARVED,
      settings: { fillMs: 100 },
    });
    const deep = runBench({ trace, pacer: SHIPPED_PACER, net: STARVED, settings: { fillMs: 600 } });
    expect(deep.stats.concealmentEvents).toBeLessThan(shallow.stats.concealmentEvents);
    expect(deep.timeToFirstAudioMs).toBeGreaterThan(shallow.timeToFirstAudioMs);
    // And on a healthy link the same span of the knob changes nothing audible.
    for (const fillMs of [100, 200, 600]) {
      const r = runBench({ trace, pacer: SHIPPED_PACER, net: TYPICAL, settings: { fillMs } });
      expect.soft(r.stats.concealedSamples, `typical link at fill=${fillMs}`).toBe(0);
    }
  });

  test("PACER_BURST_MS is subtracted from the client's cushion one-for-one", () => {
    // The burst exists to save timer wakeups on the SERVER, and it is spent out
    // of the CLIENT's resilience — a trade neither constant's doc prices. Half
    // the burst is ~100 ms more stall the caller never hears.
    const wide = absorbedStallMs({
      trace,
      pacer: { leadMs: 1000, burstMs: 400 },
      settings: SHIPPED,
    });
    const shipped = absorbedStallMs({ trace, pacer: SHIPPED_PACER, settings: SHIPPED });
    const narrow = absorbedStallMs({
      trace,
      pacer: { leadMs: 1000, burstMs: 50 },
      settings: SHIPPED,
    });
    expect(wide).toBeLessThan(shipped);
    expect(shipped).toBeLessThan(narrow);
    expect(narrow - shipped).toBeGreaterThan(50);
  });

  test("FINDING: the pacer costs no startup latency and is the ONLY source of resilience", () => {
    // The pacer exists for backpressure and for the heard cursor, not for audio
    // quality — and measuring it makes that concrete. Startup is identical at
    // every lead including no pacing at all, because the fill target is met by
    // the first frames either way; everything the pacer does to the audio is
    // subtraction from what a stall can be ridden out.
    const leads: PacerProfile[] = [
      { leadMs: 1000, burstMs: 200 },
      { leadMs: 2000, burstMs: 100 },
      { leadMs: Number.POSITIVE_INFINITY, burstMs: 200 },
    ];
    const startups = leads.map(
      (pacer) => runBench({ trace, pacer, net: TYPICAL, settings: SHIPPED }).timeToFirstAudioMs,
    );
    expect(new Set(startups).size, `startup by lead: ${startups.join(", ")}`).toBe(1);

    const absorbed = leads.map((pacer) =>
      absorbedStallMs({ trace, pacer, settings: SHIPPED, maxMs: 12_000 }),
    );
    expect(absorbed[0]).toBeLessThan(absorbed[1] ?? 0);
    expect(absorbed[1]).toBeLessThan(absorbed[2] ?? 0);
    // Unpaced rides out an unbounded freeze — the whole reply is already in the
    // client's buffer — which is the shape of the trade: the pacer's ceiling IS
    // the client's ceiling.
    expect(absorbed[2]).toBeGreaterThan(traceAudioMs(trace) - (STALL_AT_MS - 500));
  });

  test("FINDING: the ear-lag scales with the pacer's LEAD, so the two cannot be tuned apart", () => {
    // `HEARD_AUDIO_LAG_MS` (750) is documented as `PLAYBACK_JITTER_MS` (400)
    // plus a sub-second network hop. Both halves of that derivation are wrong
    // here: the cushion the client actually holds is the pacer's lead, not the
    // fill target, and it moves one-for-one WITH the lead — so raising the lead
    // for stall resilience silently invalidates the constant that decides what
    // an interrupted reply records in history.
    const depths = [
      { leadMs: 1000, burstMs: 200 },
      { leadMs: 1500, burstMs: 100 },
      { leadMs: 2000, burstMs: 100 },
    ].map((pacer) => {
      const steady = runBench({ trace, pacer, net: TYPICAL, settings: SHIPPED }).progressMs.slice(
        0,
        -1,
      );
      return steady.slice().sort((a, b) => a - b)[steady.length >> 1] ?? 0;
    });
    for (const [i, depth] of depths.entries()) {
      if (i === 0) continue;
      expect
        .soft(depth, `depth grows with lead: ${depths.join(", ")}`)
        .toBeGreaterThan((depths[i - 1] ?? 0) + 300);
    }
    // And the fill target, which the constant USED to be derived from, moves it
    // barely — which is why the derivation had to change with the pacer, not
    // with the worklet.
    const byTarget = [100, 400].map((fillMs) => {
      const steady = runBench({
        trace,
        pacer: SHIPPED_PACER,
        net: TYPICAL,
        settings: { fillMs },
      }).progressMs.slice(0, -1);
      return steady.slice().sort((a, b) => a - b)[steady.length >> 1] ?? 0;
    });
    expect(Math.abs((byTarget[1] ?? 0) - (byTarget[0] ?? 0))).toBeLessThan(100);
  });

  test("the derived HEARD_AUDIO_LAG_MS now AGREES with the measured buffer depth", () => {
    // It used to be a literal 750 decomposed from the deleted startup target,
    // and this test asserted the two DISAGREED — measured depth ~864 ms against
    // 750, under-subtracting, which is the direction that records words the
    // caller never heard. It is `CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS / 2` now,
    // so the assertion flips: the formula has to predict what the bench measures,
    // and it is this test that fails if either pacer constant moves without the
    // heard cursor following.
    const r = runBench({ trace, pacer: SHIPPED_PACER, net: TYPICAL, settings: SHIPPED });
    // Drop the final drain, which is playout emptying rather than steady state.
    const steady = r.progressMs.slice(0, -1);
    const median = steady.slice().sort((a, b) => a - b)[steady.length >> 1] ?? 0;
    const predicted = SHIPPED_PACER.leadMs - SHIPPED_PACER.burstMs / 2;
    expect(
      Math.abs(median - predicted),
      `measured depth ${median.toFixed(0)} ms vs derived ${predicted} ms`,
    ).toBeLessThan(100);
  });

  test("the score ranks a clean render above a stalled one", () => {
    // The weights in `scoreRender` are the bench's one opinion; this keeps them
    // from silently inverting, which would quietly re-rank every sweep above.
    const clean = scoreRender(
      runBench({ trace, pacer: SHIPPED_PACER, net: TYPICAL, settings: SHIPPED }),
    );
    const stalled = scoreRender(
      runBench({ trace, pacer: SHIPPED_PACER, net: stall(3000, 1500), settings: SHIPPED }),
    );
    expect(clean.score).toBeLessThan(stalled.score);
    expect(clean.parts.silentMs).toBe(0);
    expect(stalled.parts.silentMs).toBeGreaterThan(0);
  });
});
