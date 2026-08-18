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
import {
  CLIENT_AUDIO_LEAD_MS,
  HEARD_AUDIO_LAG_MS,
  PACER_BURST_MS,
  PIPELINE_PLAYBACK_GRACE_MS,
  PLAYBACK_FILL_MS,
  PLAYBACK_PROGRESS_INTERVAL_MS,
} from "../types.ts";
import {
  type Delivery,
  EAR_SAMPLE_MS,
  type NetworkProfile,
  overNetwork,
  type PacerProfile,
  pacedSends,
  type RenderResult,
  renderSchedule,
  runBench,
  scoreRender,
} from "./_playback-bench-harness.ts";
import { playoutVsHost } from "./_playback-bench-host.ts";
import {
  hasTtsTrace,
  readTtsTraceSync,
  type TtsTrace,
  traceAudioMs,
} from "./_tts-trace-harness.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const TRACE = "tts-reply-24k";

/**
 * Production's pacing — the REAL constants. They were literals here until the
 * measurements below made the case for putting them on `@alexkroman1/aai/internal`:
 * they decide how much audio the browser's playback buffer holds, so a bench that
 * restates them is a bench measuring a copy nothing checks.
 */
const SHIPPED_PACER: PacerProfile = {
  leadMs: CLIENT_AUDIO_LEAD_MS,
  burstMs: PACER_BURST_MS,
};
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

  /**
   * The error in the host's heard cursor, in ms: what it believes the caller has
   * heard, minus what the ear actually received. POSITIVE means it over-keeps.
   *
   * Transcribed from `heardMs()` in `aai/host/transports/pipeline-heard.ts` —
   * `audioMs - clock.remainingMs() - lagMs` over the FORWARDED schedule, since the
   * host sees what it sent and not what the wire did with it — and compared against
   * `RenderResult.earMs`, which counts only delivered (never concealed) samples.
   * Sampled mid-reply, where a barge-in happens, and reported as the median.
   */
  function heardErrorMs(pacer: PacerProfile, net: NetworkProfile, lagMs: number): number {
    const forwarded = pacedSends(trace, pacer);
    const render = runBenchWith(forwarded, net);
    const rate = trace.sampleRate;
    const errors: number[] = [];
    for (const [i, truthMs] of render.earMs.entries()) {
      const tMs = i * EAR_SAMPLE_MS;
      if (truthMs <= 200 || tMs > traceAudioMs(trace) - 500) continue;
      let audioMs = 0;
      let endsAtMs = 0;
      for (const d of forwarded) {
        if (d.atMs > tMs) break;
        const chunkMs = (d.bytes.byteLength / 2 / rate) * 1000;
        audioMs += chunkMs;
        endsAtMs = Math.max(endsAtMs, d.atMs) + chunkMs;
      }
      const remainingMs = Math.max(0, endsAtMs - tMs);
      const hostMs = Math.max(0, Math.min(audioMs, audioMs - remainingMs - lagMs));
      errors.push(hostMs - truthMs);
    }
    errors.sort((a, b) => a - b);
    return errors[errors.length >> 1] ?? 0;
  }

  /** The smallest barge-in grace that keeps `pending()` true to the last sample. */
  function requiredGraceMs(pacer: PacerProfile, net: NetworkProfile): number {
    const forwarded = pacedSends(trace, pacer);
    return playoutVsHost({
      forwarded,
      render: runBenchWith(forwarded, net),
      sampleRate: trace.sampleRate,
      reportIntervalMs: PLAYBACK_PROGRESS_INTERVAL_MS,
    }).requiredGraceMs;
  }

  /** Render an already-paced schedule over a link, at the shipped fill target. */
  function runBenchWith(forwarded: Delivery[], net: NetworkProfile): RenderResult {
    return renderSchedule(overNetwork(forwarded, net), {
      sampleRate: trace.sampleRate,
      settings: SHIPPED,
    });
  }

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
    const r = runBench({
      trace,
      pacer: SHIPPED_PACER,
      net: stall(3000, SHIPPED_PACER.leadMs + 1000),
      settings: SHIPPED,
    });
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
    const at = (burstMs: number): number =>
      absorbedStallMs({
        trace,
        pacer: { leadMs: SHIPPED_PACER.leadMs, burstMs },
        settings: SHIPPED,
        maxMs: 4000,
      });
    const wide = at(PACER_BURST_MS * 4);
    const shipped = at(PACER_BURST_MS);
    const narrow = at(PACER_BURST_MS / 2);
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

  test("FINDING: the heard cursor's error does NOT scale with the pacer's lead", () => {
    // The correction that cost this branch a second commit. The client's buffer
    // depth DOES track the lead — that much is measured above — and the tempting
    // conclusion is that `HEARD_AUDIO_LAG_MS` must therefore be derived from it.
    // It must not: `heardMs()` in `aai/host/transports/pipeline-heard.ts` is
    // `audioMs - clock.remainingMs() - lagMs`, and `endsAtMs` inside that clock
    // accumulates from `max(endsAtMs, now())`, so it already runs ahead by
    // whatever the lead is. The depth is subtracted BEFORE the constant applies.
    //
    // So this drives the host's own arithmetic against the audio the ear really
    // received, at three leads, and the error is identical across them.
    const errors = [CLIENT_AUDIO_LEAD_MS, 1500, 2000].map((leadMs) =>
      heardErrorMs({ leadMs, burstMs: PACER_BURST_MS }, TYPICAL, HEARD_AUDIO_LAG_MS),
    );
    const spread = Math.max(...errors) - Math.min(...errors);
    expect(
      spread,
      `heard error by lead: ${errors.map((e) => e.toFixed(0)).join(", ")}`,
    ).toBeLessThan(20);
  });

  test("HEARD_AUDIO_LAG_MS leaves the heard cursor erring EARLY, by tens of ms", () => {
    // The direction is the contract (`pipeline-heard.ts`: over-keeping is the
    // measured failure, under-keeping costs a word or two of redundancy), and the
    // MAGNITUDE is what two wrong derivations got wrong — 750 left the cursor
    // ~694 ms early on this link and 950 left it ~894 ms, which is ~10 words
    // rather than one or two.
    for (const net of [PERFECT, TYPICAL, MOBILE]) {
      const err = heardErrorMs(SHIPPED_PACER, net, HEARD_AUDIO_LAG_MS);
      expect.soft(err, `${net.name}: cursor must not run ahead of the ear`).toBeLessThanOrEqual(0);
      expect
        .soft(err, `${net.name}: and must not lag it by more than a word or two`)
        .toBeGreaterThan(-250);
    }
    // With the term at zero the cursor is already accurate to tens of ms, which
    // is the evidence that it is a network hop and not a buffer depth.
    expect(Math.abs(heardErrorMs(SHIPPED_PACER, TYPICAL, 0))).toBeLessThan(150);
  });

  test("PIPELINE_PLAYBACK_GRACE_MS clears what barge-in actually requires", () => {
    // The grace keeps `pending()` true while the caller can still hear forwarded
    // audio, so a value below the requirement misses a barge-in in the reply's
    // tail. Measured the same way, and it does not scale with the lead either —
    // it was briefly believed to be ~200 ms short and to block raising the lead.
    for (const leadMs of [CLIENT_AUDIO_LEAD_MS, 2000]) {
      for (const net of [PERFECT, TYPICAL, MOBILE]) {
        const required = requiredGraceMs({ leadMs, burstMs: PACER_BURST_MS }, net);
        expect
          .soft(required, `lead ${leadMs} on ${net.name} requires ${required.toFixed(0)} ms`)
          .toBeLessThan(PIPELINE_PLAYBACK_GRACE_MS);
      }
    }
  });

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
