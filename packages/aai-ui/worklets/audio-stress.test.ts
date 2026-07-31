// Copyright 2026 the AAI authors. MIT license.
/**
 * Stress tests for the two audio worklet processors: seeded-random message
 * timing, chunk sizing, stalls, barge-ins, and press cycles, with
 * sample-exact integrity checks. The point is not any single scenario but
 * the invariants that must hold through *all* of them:
 *
 * - Playback never drops, reorders, or duplicates a delivered sample, no
 *   matter how the bytes are chunked (odd splits included), how renders
 *   interleave with writes, or how often the buffer underruns.
 * - Every turn ends with exactly one 'stop', tagged with the right reason.
 * - Capture records exactly the samples fed between 'start' and 'stop',
 *   converts them deterministically, and never leaks audio across presses.
 * - process() always returns true (a false return kills a processor for
 *   good) and never throws.
 *
 * Randomness is a seeded PRNG so every failure reproduces exactly.
 *
 * Real-sample detection under concealment: delivered PCM16 renders as
 * v/0x8000 — multiplied back by 0x8000 that is an exact integer. Concealment
 * replays *already played* audio under a decaying irrational gain, so its
 * samples are either non-integers on that grid or integers strictly below
 * the next undelivered value. A strictly increasing source ramp therefore
 * lets one scan prove losslessness and ordering even while concealment is
 * fabricating audio in between.
 */

import { describe, expect, test } from "vitest";
import { instantiateWorklet, type WorkletHarness } from "./_worklet-test-utils.ts";
import { captureProcessorSource } from "./capture-processor.ts";
import { playbackProcessorSource } from "./playback-processor.ts";

const QUANTUM = 128;

/** Deterministic PRNG (mulberry32) so failures reproduce exactly. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Random integer in [1, max]. */
const randInt = (r: () => number, max: number): number => 1 + Math.floor(r() * max);

/** PCM16 LE bytes for a list of int16 sample values. */
const toBytes = (values: number[]): Uint8Array => new Uint8Array(new Int16Array(values).buffer);

/** Split bytes into randomly sized chunks (1..maxBytes, odd sizes included). */
function randomChunks(r: () => number, bytes: Uint8Array, maxBytes: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const n = Math.min(randInt(r, maxBytes), bytes.length - at);
    chunks.push(bytes.subarray(at, at + n));
    at += n;
  }
  return chunks;
}

/** Render one playback quantum; a dead processor is an immediate failure. */
function render(w: WorkletHarness): Float32Array {
  const out = new Float32Array(QUANTUM);
  if (!w.instance.process([], [[out]])) {
    throw new Error("playback process() returned false — processor died");
  }
  return out;
}

type Stop = { event: string; reason: string; stats: { concealedSamples: number } };
const stops = (posted: unknown[]): Stop[] =>
  posted.filter((p): p is Stop => (p as Stop).event === "stop");

/**
 * Scan rendered samples for the strictly increasing source ramp
 * `expectedNext, expectedNext+1, …`. Any integer-grid sample at or above
 * `expectedNext` must be exactly `expectedNext` (no loss, no reordering,
 * no duplication of undelivered audio); everything else is silence or
 * concealment and is ignored. Returns the updated expectation; throws on
 * the first out-of-order or skipped-ahead sample.
 */
function consumeRamp(rendered: readonly number[], expectedNext: number): number {
  let next = expectedNext;
  for (const s of rendered) {
    const v = s * 0x80_00;
    if (Number.isInteger(v) && v >= next) {
      if (v !== next) throw new Error(`rendered ${v} before ${next} — lost or reordered audio`);
      next++;
    }
  }
  return next;
}

/** Drain a turn: render until its stop posts; bounded so a hang is a failure. */
function drainToStop(w: WorkletHarness, collect: number[], maxQuanta: number): void {
  const before = stops(w.posted).length;
  for (let i = 0; i < maxQuanta; i++) {
    collect.push(...render(w));
    if (stops(w.posted).length > before) return;
  }
  throw new Error(`turn did not end within ${maxQuanta} quanta`);
}

/**
 * One turn of the barge-in storm: deliver a ramp in random chunks with
 * random renders interleaved, then either interrupt mid-delivery (with the
 * next turn's traffic free to coalesce right behind — the caller writes
 * immediately, no process() in between) or complete the turn and verify the
 * whole ramp played.
 */
function stormTurn(w: WorkletHarness, r: () => number): "interrupt" | "done" {
  const source = Array.from({ length: randInt(r, 3000) + 200 }, (_, i) => i + 1);
  const chunks = randomChunks(r, toBytes(source), 2048);
  const interrupted = r() < 0.5;
  const deliverUpTo = interrupted ? randInt(r, chunks.length) : chunks.length;

  const rendered: number[] = [];
  for (let i = 0; i < deliverUpTo; i++) {
    w.sendMessage({ event: "write", buffer: chunks[i] as Uint8Array });
    if (r() < 0.3) rendered.push(...render(w));
  }

  if (interrupted) {
    w.sendMessage({ event: "interrupt" });
    return "interrupt";
  }
  w.sendMessage({ event: "done" });
  drainToStop(w, rendered, source.length / QUANTUM + 200);
  const next = consumeRamp(rendered, 1);
  if (next !== source.length + 1) {
    throw new Error(`completed turn played ${next - 1} of ${source.length} samples`);
  }
  return "done";
}

describe("playback stress", () => {
  test("fuzzed chunk sizes and odd splits never lose, reorder, or corrupt a sample", () => {
    // Three seeds × one second of audio in chunks of 1..4097 bytes. With all
    // audio buffered before rendering there is no underrun, so every nonzero
    // rendered sample must be real — the full ramp, in order, exactly.
    for (const seed of [1, 2, 3]) {
      const r = rng(seed);
      const w = instantiateWorklet(playbackProcessorSource, {}, 24_000);
      const source = Array.from({ length: 24_000 }, (_, i) => i + 1);
      for (const chunk of randomChunks(r, toBytes(source), 4097)) {
        w.sendMessage({ event: "write", buffer: chunk });
      }
      w.sendMessage({ event: "done" });

      const rendered: number[] = [];
      drainToStop(w, rendered, source.length / QUANTUM + 16);

      expect(rendered.filter((s) => s !== 0)).toEqual(source.map((v) => v / 0x80_00));
      const [stop] = stops(w.posted);
      expect(stop?.reason).toBe("done");
      expect(stop?.stats.concealedSamples).toBe(0);
    }
  });

  test("the ring buffer survives wrapping several times without corruption", () => {
    // rate 500 -> capacity 30_000 samples; 70_000 delivered means the ring
    // wraps twice. Writes and renders interleave so the fill stays inside
    // the ring (overflow would legitimately drop audio) but never underruns
    // (an underrun would conceal); the rendered stream must then be the
    // source, byte for byte.
    const r = rng(7);
    const w = instantiateWorklet(playbackProcessorSource, {}, 500);
    const source = Array.from({ length: 70_000 }, (_, i) => (i % 30_000) + 1);
    const rendered: number[] = [];

    let delivered = 0;
    let renderedReal = 0;
    for (const chunk of randomChunks(r, toBytes(source), 2048)) {
      // Never overfill past the ring capacity; renders only happen with the
      // buffer far above one quantum, so nothing underruns either.
      while (delivered + chunk.length / 2 - renderedReal > 29_000) {
        rendered.push(...render(w));
        renderedReal += QUANTUM;
      }
      w.sendMessage({ event: "write", buffer: chunk });
      delivered += chunk.length / 2;
    }
    w.sendMessage({ event: "done" });
    drainToStop(w, rendered, (delivered - renderedReal) / QUANTUM + 16);

    expect(rendered.filter((s) => s !== 0)).toEqual(source.map((v) => v / 0x80_00));
    expect(stops(w.posted)[0]?.stats.concealedSamples).toBe(0);
  });

  test("random stalls conceal gaps but never lose or reorder real audio", () => {
    // Writes and renders interleave with seeded-random pacing, so the buffer
    // underruns repeatedly mid-turn (hysteresis + concealment active). The
    // ramp scan proves every delivered sample still plays exactly once, in
    // order, around whatever the concealer fabricated.
    for (const seed of [11, 12, 13]) {
      const r = rng(seed);
      const w = instantiateWorklet(playbackProcessorSource, {}, 24_000);
      const source = Array.from({ length: 12_000 }, (_, i) => i + 1);
      const chunks = randomChunks(r, toBytes(source), 3000);
      const rendered: number[] = [];

      let i = 0;
      while (i < chunks.length) {
        if (r() < 0.4) {
          w.sendMessage({ event: "write", buffer: chunks[i] as Uint8Array });
          i++;
        } else {
          // Random renders — often against an empty or filling buffer.
          rendered.push(...render(w));
        }
      }
      w.sendMessage({ event: "done" });
      drainToStop(w, rendered, source.length / QUANTUM + 200);

      expect(consumeRamp(rendered, 1)).toBe(source.length + 1);
      expect(stops(w.posted)).toHaveLength(1);
      expect(stops(w.posted)[0]?.reason).toBe("done");
    }
  });

  test("a barge-in storm never bleeds audio between turns or double-ends one", () => {
    // 24 turns; roughly half are interrupted mid-delivery, and after every
    // interrupt the next turn's first writes are delivered in the same
    // inter-quantum gap — the coalescing pattern of a janked main thread.
    // Every completed turn must play its full ramp (stormTurn throws
    // otherwise); every turn must end exactly once with the right reason.
    const r = rng(21);
    const w = instantiateWorklet(playbackProcessorSource, {}, 24_000);
    let interrupts = 0;
    let dones = 0;

    for (let turn = 0; turn < 24; turn++) {
      if (stormTurn(w, r) === "interrupt") interrupts++;
      else dones++;

      const seen = stops(w.posted);
      expect(seen).toHaveLength(interrupts + dones);
      expect(seen.filter((s) => s.reason === "interrupt")).toHaveLength(interrupts);
      expect(seen.filter((s) => s.reason === "done")).toHaveLength(dones);
    }
  });
});

/** Mirror of the capture worklet's Float32 -> Int16 conversion. */
function expectedPcm(samples: readonly number[]): number[] {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    out[i] = s < 0 ? s * 0x80_00 : s * 0x7f_ff;
  }
  return [...out];
}

/** Concatenated PCM across every 'chunk' message in `posted`. */
const chunkPcm = (posted: unknown[]): number[] =>
  posted
    .filter(
      (p): p is { event: string; buffer: ArrayBuffer } =>
        (p as { event: string }).event === "chunk",
    )
    .flatMap((c) => [...new Int16Array(c.buffer)]);

/** Feed `quanta` random-signal render quanta; returns every sample fed. */
function feedRandomQuanta(w: WorkletHarness, r: () => number, quanta: number): number[] {
  const fed: number[] = [];
  for (let q = 0; q < quanta; q++) {
    const input = new Float32Array(QUANTUM);
    for (let i = 0; i < QUANTUM; i++) input[i] = r() * 2 - 1;
    fed.push(...input);
    if (!w.instance.process([[input]], [])) {
      throw new Error("capture process() returned false — processor died");
    }
  }
  return fed;
}

describe("capture stress", () => {
  test("press cycles record exactly what was fed, and nothing between presses", () => {
    const r = rng(31);
    const w = instantiateWorklet(captureProcessorSource, {
      sampleRate: 16_000,
      bufferSeconds: 0.016, // 256-sample batches: many flushes per cycle
    });

    for (let cycle = 0; cycle < 20; cycle++) {
      // Off-cycle audio must vanish: the worklet is not recording.
      const before = w.posted.length;
      feedRandomQuanta(w, r, 5);
      expect(w.posted.length).toBe(before);

      // One press: random quanta of random signal, then stop.
      w.sendMessage({ event: "start" });
      const startAt = w.posted.length;
      const fed = feedRandomQuanta(w, r, randInt(r, 30));
      w.sendMessage({ event: "stop" });

      const posted = w.posted.slice(startAt);
      // The final flush precedes the ack — the ordering stop() relies on.
      expect((posted.at(-1) as { event: string }).event).toBe("stopped");
      expect(chunkPcm(posted)).toEqual(expectedPcm(fed));
    }
  });

  test("a quantum larger than the batch headroom grows the buffer intact", () => {
    const w = instantiateWorklet(captureProcessorSource, {
      sampleRate: 16_000,
      bufferSeconds: 0.016, // 256-sample target, 512-sample headroom
    });
    w.sendMessage({ event: "start" });

    const giant = new Float32Array(4096);
    for (let i = 0; i < giant.length; i++) giant[i] = ((i % 100) - 50) / 64;
    expect(w.instance.process([[giant]], [])).toBe(true);
    w.sendMessage({ event: "stop" });

    expect(chunkPcm(w.posted)).toEqual(expectedPcm([...giant]));
  });

  test("capture-to-playback round trip is transparent within two quantization steps", () => {
    const r = rng(41);
    const cap = instantiateWorklet(captureProcessorSource, {
      sampleRate: 16_000,
      bufferSeconds: 0.032,
    });
    cap.sendMessage({ event: "start" });
    const fed = feedRandomQuanta(cap, r, 40);
    cap.sendMessage({ event: "stop" });

    const play = instantiateWorklet(playbackProcessorSource, {}, 16_000);
    for (const p of cap.posted) {
      const msg = p as { event: string; buffer?: ArrayBuffer };
      if (msg.event === "chunk" && msg.buffer) {
        play.sendMessage({ event: "write", buffer: new Uint8Array(msg.buffer) });
      }
    }
    play.sendMessage({ event: "done" });

    const rendered: number[] = [];
    drainToStop(play, rendered, fed.length / QUANTUM + 16);

    let maxErr = 0;
    for (let i = 0; i < fed.length; i++) {
      maxErr = Math.max(maxErr, Math.abs((rendered[i] as number) - (fed[i] as number)));
    }
    // Encode scales positives by 0x7fff and truncates; decode divides by
    // 0x8000 — for arbitrary (non-dyadic) floats the asymmetry compounds to
    // at most two quantization steps.
    expect(maxErr).toBeLessThanOrEqual(2 / 0x80_00);
    expect(stops(play.posted)[0]?.stats.concealedSamples).toBe(0);
  });
});
