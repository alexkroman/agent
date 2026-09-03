// Copyright 2026 the AAI authors. MIT license.
/**
 * Stress tests for the two audio worklet processors: generated message
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
 * Randomness comes from fast-check, so a failure shrinks to the smallest input
 * that still breaks an invariant — commonly one chunk size or a single turn.
 *
 * Chunk sizes, pacing decisions, and signal values are generated as SHORT lists
 * consumed CYCLICALLY rather than one entry per chunk or sample: a second of
 * audio is thousands of chunks, and generating one entry each would print a wall
 * of a counterexample that shrinks to nothing readable. Two of these tests stay
 * fully deterministic (a giant quantum, and the ring-wrap pacing that has to
 * track buffer fill), because their inputs are not a free choice.
 *
 * Real-sample detection under concealment: delivered PCM16 renders as
 * v/0x8000 — multiplied back by 0x8000 that is an exact integer. Concealment
 * replays *already played* audio under a decaying irrational gain, so its
 * samples are either non-integers on that grid or integers strictly below
 * the next undelivered value. A strictly increasing source ramp therefore
 * lets one scan prove losslessness and ordering even while concealment is
 * fabricating audio in between.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { instantiateWorklet, type WorkletHarness } from "./_worklet-test-utils.ts";
import { captureProcessorSource } from "./capture-processor.ts";
import { playbackProcessorSource } from "./playback-processor.ts";

const QUANTUM = 128;

/**
 * States the generators must actually reach, counted after each property and
 * floored where the state is reliably reached.
 *
 * fast-check has no coverage-floor mechanism (`fc.statistics` only prints), and
 * an all-green property proves nothing about a state the generator never
 * entered — see "Property tests run on fast-check" in the root guide.
 *
 * `interrupts`/`completions` are the pair that matters most: `interruptAfter`
 * is an `fc.option`, so the barge-in storm's turn counters can legitimately
 * come out all-done or all-interrupt — and `toHaveLength(0)` compared against
 * `toHaveLength(0)` is the whole of what an all-done run asserts about
 * barge-in.
 *
 * `concealments` is counted and deliberately NOT floored, which is a finding
 * rather than an omission. The stall test below is named for concealment and
 * its comment claims the buffer "underruns repeatedly mid-turn", and it does
 * not: measured across runs of 25, concealment is reached in 1-5 of them and
 * `concealedSamples` is 0 in the rest. The cause is the generator's weighting,
 * not the processor — `sizesArb(3000)` averages ~750 samples a chunk against
 * 128 consumed per render, so writes outrun renders by an order of magnitude
 * and the buffer effectively never starves. Lengthening the source, lowering
 * the fill target, and adding explicit multi-quantum stall bursts were
 * each measured and each left it at 1-5 of 25. A floor here would flake; the
 * fix is a starvation-weighted chunk-size arbitrary, which is its own change.
 *
 * What is NOT at risk meanwhile: the concealment path itself has example
 * coverage in `playback-processor.test.ts`, which reaches it deterministically
 * with a tuned processor (`fillMs: 20`) and pins the counters, the fade to
 * silence, and the resume-where-it-left-off behaviour. This property's own
 * assertions — a complete, in-order ramp around whatever the concealer
 * fabricated — hold either way. *
 * Each floor sits under the OBSERVED MINIMUM across the runs recorded beside
 * it, not at a fixed fraction of the mean. These distributions have long left
 * tails — a counter averaging 38 was measured at 3 on one run — because what a
 * walk reaches is correlated within a run rather than independent per step, so
 * a floor placed under the mean flakes. The job of the floor is to catch a
 * state that is NEVER reached, not to pin how often; a state whose whole range
 * is small therefore gets `> 0`, which is still the assertion that matters.
 */
type Reached = {
  /** Quanta of concealment the stall property provoked. Reported, not floored. */
  concealments: number;
  /** Turns the barge-in storm cut off mid-delivery. */
  interrupts: number;
  /** Turns the barge-in storm played out in full. */
  completions: number;
  /** Capture press cycles driven, each asserting a sample-exact recording. */
  pressCycles: number;
};
const reached: Reached = { concealments: 0, interrupts: 0, completions: 0, pressCycles: 0 };

/** PCM16 LE bytes for a list of int16 sample values. */
const toBytes = (values: number[]): Uint8Array => new Uint8Array(new Int16Array(values).buffer);

/**
 * Split bytes into chunks of the given sizes, cycled. Odd sizes are the point:
 * a chunk ending mid-sample is what the processor has to carry across.
 */
function chunkBySizes(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let at = 0;
  let i = 0;
  while (at < bytes.length) {
    const n = Math.min(sizes[i++ % sizes.length] as number, bytes.length - at);
    chunks.push(bytes.subarray(at, at + n));
    at += n;
  }
  return chunks;
}

/** Chunk-size scripts, cycled by {@link chunkBySizes}. */
const sizesArb = (maxBytes: number): fc.Arbitrary<number[]> =>
  fc.array(fc.integer({ min: 1, max: maxBytes }), { minLength: 1, maxLength: 12 });

/**
 * A pacing script: true = deliver the next chunk, false = render a quantum.
 *
 * At least one `true` is FORCED. A script of all-false never delivers anything,
 * so the delivery loop renders forever — the generator breaking its own
 * contract, which reports as a harness crash (`RangeError: Invalid array
 * length`, after a minute of rendering) rather than as a finding. Appending
 * rather than filtering keeps shrinking well behaved: every generated value maps
 * to a legal one instead of being discarded.
 */
const pacingArb = fc
  .array(fc.boolean(), { minLength: 2, maxLength: 16 })
  .map((pacing) => (pacing.includes(true) ? pacing : [...pacing, true]));

/** Signal values in [-1, 1], cycled to fill capture quanta. */
const signalArb = fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
  minLength: 1,
  maxLength: 16,
});

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

/** One turn of the barge-in storm. */
type StormTurn = {
  samples: number;
  sizes: number[];
  /** Cut the turn off after this FRACTION of its chunks (null = play it out). */
  interruptAfter: number | null;
  /** Which inter-chunk gaps render a quantum, cycled. */
  renderAt: boolean[];
};

const stormTurnArb: fc.Arbitrary<StormTurn> = fc.record({
  samples: fc.integer({ min: 201, max: 3200 }),
  sizes: sizesArb(2048),
  interruptAfter: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
  renderAt: fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
});

/**
 * One turn of the barge-in storm: deliver a ramp in the given chunk sizes with
 * renders interleaved, then either interrupt mid-delivery (with the next turn's
 * traffic free to coalesce right behind — the caller writes immediately, no
 * process() in between) or complete the turn and verify the whole ramp played.
 */
function stormTurn(w: WorkletHarness, turn: StormTurn): "interrupt" | "done" {
  const source = Array.from({ length: turn.samples }, (_, i) => i + 1);
  const chunks = chunkBySizes(toBytes(source), turn.sizes);
  const cutAt = turn.interruptAfter;
  const deliverUpTo =
    cutAt === null ? chunks.length : Math.max(1, Math.ceil(cutAt * chunks.length));

  const rendered: number[] = [];
  for (let i = 0; i < deliverUpTo; i++) {
    w.sendMessage({ event: "write", buffer: chunks[i] as Uint8Array });
    if (turn.renderAt[i % turn.renderAt.length] === true) rendered.push(...render(w));
  }

  if (cutAt !== null) {
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
    // One second of audio in chunks of 1..4097 bytes. With all audio buffered
    // before rendering there is no underrun, so every nonzero rendered sample
    // must be real — the full ramp, in order, exactly.
    fc.assert(
      fc.property(sizesArb(4097), (sizes) => {
        const w = instantiateWorklet(playbackProcessorSource, {}, 24_000);
        const source = Array.from({ length: 24_000 }, (_, i) => i + 1);
        for (const chunk of chunkBySizes(toBytes(source), sizes)) {
          w.sendMessage({ event: "write", buffer: chunk });
        }
        w.sendMessage({ event: "done" });

        const rendered: number[] = [];
        drainToStop(w, rendered, source.length / QUANTUM + 16);

        expect(rendered.filter((s) => s !== 0)).toEqual(source.map((v) => v / 0x80_00));
        const [stop] = stops(w.posted);
        expect(stop?.reason).toBe("done");
        expect(stop?.stats.concealedSamples).toBe(0);
      }),
      { numRuns: 25 },
    );
  }, 60_000);

  test("the ring buffer survives wrapping several times without corruption", () => {
    // rate 500 -> capacity 30_000 samples; 70_000 delivered means the ring
    // wraps twice. Writes and renders interleave so the fill stays inside
    // the ring (overflow would legitimately drop audio) but never underruns
    // (an underrun would conceal); the rendered stream must then be the
    // source, byte for byte.
    //
    // Deliberately NOT a property: the pacing has to track buffer fill to stay
    // in the no-overflow/no-underrun window, so it is computed, not chosen. Only
    // the chunk sizes are free, and a fixed repeating pattern of odd sizes
    // exercises the wrap boundary as well as a generated one.
    const w = instantiateWorklet(playbackProcessorSource, {}, 500);
    const source = Array.from({ length: 70_000 }, (_, i) => (i % 30_000) + 1);
    const rendered: number[] = [];

    let delivered = 0;
    let renderedReal = 0;
    for (const chunk of chunkBySizes(toBytes(source), [2048, 3, 511, 1, 1023, 2047])) {
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

  test("interleaved writes and renders never lose or reorder real audio", () => {
    // Writes and renders interleave on a generated pacing script. The ramp scan
    // proves every delivered sample still plays exactly once, in order, around
    // whatever the concealer fabricated.
    //
    // It was called "random stalls conceal gaps" and claimed the buffer
    // "underruns repeatedly mid-turn (hysteresis + concealment active)". It
    // does not — see `Reached`, which measures it and says why the honest
    // reading is "renders may land on a filling buffer", not "this is the
    // concealment test". `playback-processor.test.ts` is the concealment test.
    fc.assert(
      fc.property(sizesArb(3000), pacingArb, (sizes, pacing) => {
        const w = instantiateWorklet(playbackProcessorSource, {}, 24_000);
        const source = Array.from({ length: 12_000 }, (_, i) => i + 1);
        const chunks = chunkBySizes(toBytes(source), sizes);
        const rendered: number[] = [];

        let i = 0;
        let p = 0;
        while (i < chunks.length) {
          if (pacing[p++ % pacing.length] === true) {
            w.sendMessage({ event: "write", buffer: chunks[i] as Uint8Array });
            i++;
          } else {
            // Renders against an empty or filling buffer.
            rendered.push(...render(w));
          }
        }
        w.sendMessage({ event: "done" });
        drainToStop(w, rendered, source.length / QUANTUM + 200);

        expect(consumeRamp(rendered, 1)).toBe(source.length + 1);
        expect(stops(w.posted)).toHaveLength(1);
        expect(stops(w.posted)[0]?.reason).toBe("done");
        reached.concealments += stops(w.posted)[0]?.stats.concealedSamples ?? 0;
      }),
      { numRuns: 25 },
    );

    // No floor on `reached.concealments` — see `Reached` for the measurement
    // and the reason. What IS asserted is the ramp itself, above, per run.
  }, 60_000);

  test("a barge-in storm never bleeds audio between turns or double-ends one", () => {
    // Many turns; roughly half are interrupted mid-delivery, and after every
    // interrupt the next turn's first writes are delivered in the same
    // inter-quantum gap — the coalescing pattern of a janked main thread.
    // Every completed turn must play its full ramp (stormTurn throws
    // otherwise); every turn must end exactly once with the right reason.
    fc.assert(
      fc.property(fc.array(stormTurnArb, { minLength: 1, maxLength: 24 }), (turns) => {
        const w = instantiateWorklet(playbackProcessorSource, {}, 24_000);
        let interrupts = 0;
        let dones = 0;

        for (const turn of turns) {
          if (stormTurn(w, turn) === "interrupt") interrupts++;
          else dones++;

          const seen = stops(w.posted);
          expect(seen).toHaveLength(interrupts + dones);
          expect(seen.filter((s) => s.reason === "interrupt")).toHaveLength(interrupts);
          expect(seen.filter((s) => s.reason === "done")).toHaveLength(dones);
        }
        reached.interrupts += interrupts;
        reached.completions += dones;
      }),
      { numRuns: 20 },
    );

    // Coverage floors — see `Reached` for how these are placed; ranges are over
    // 17 runs of 20. Both directions matter: an all-done run asserts
    // `toHaveLength(0)` about barge-in, and an all-interrupt run never reaches
    // `stormTurn`'s full-ramp check.
    expect(reached.interrupts, "no turn was ever cut off — barge-in went untested").toBeGreaterThan(
      22,
    ); // 80-120
    expect(reached.completions, "no turn ever played out in full").toBeGreaterThan(2); // 9-33
  }, 60_000);
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

/**
 * Feed `quanta` render quanta whose samples cycle through `signal`; returns
 * every sample fed.
 */
function feedQuanta(
  w: WorkletHarness,
  signal: readonly number[],
  quanta: number,
  offset: { at: number },
): number[] {
  const fed: number[] = [];
  for (let q = 0; q < quanta; q++) {
    const input = new Float32Array(QUANTUM);
    for (let i = 0; i < QUANTUM; i++) {
      input[i] = signal[offset.at++ % signal.length] as number;
    }
    fed.push(...input);
    if (!w.instance.process([[input]], [])) {
      throw new Error("capture process() returned false — processor died");
    }
  }
  return fed;
}

describe("capture stress", () => {
  test("press cycles record exactly what was fed, and nothing between presses", () => {
    fc.assert(
      fc.property(
        signalArb,
        fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 20 }),
        (signal, cycles) => {
          const w = instantiateWorklet(captureProcessorSource, {
            sampleRate: 16_000,
            bufferSeconds: 0.016, // 256-sample batches: many flushes per cycle
          });
          const offset = { at: 0 };

          for (const quanta of cycles) {
            // Off-cycle audio must vanish: the worklet is not recording.
            const before = w.posted.length;
            feedQuanta(w, signal, 5, offset);
            expect(w.posted.length).toBe(before);

            // One press: the cycle's quanta of signal, then stop.
            w.sendMessage({ event: "start" });
            const startAt = w.posted.length;
            const fed = feedQuanta(w, signal, quanta, offset);
            w.sendMessage({ event: "stop" });

            const posted = w.posted.slice(startAt);
            // The final flush precedes the ack — the ordering stop() relies on.
            expect((posted.at(-1) as { event: string }).event).toBe("stopped");
            expect(chunkPcm(posted)).toEqual(expectedPcm(fed));
            reached.pressCycles += 1;
          }
        },
      ),
      { numRuns: 25 },
    );

    // Coverage floor — see `Reached`. `cycles` is generated, so this catches an
    // arbitrary that stopped producing press cycles to drive.
    expect(reached.pressCycles, "no press cycle was ever recorded").toBeGreaterThan(30); // 106-172
  }, 60_000);

  test("a quantum larger than the batch headroom grows the buffer intact", () => {
    // Deterministic on purpose: the input is one specific shape — a quantum
    // bigger than the batch headroom — not a value worth generating.
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
    // Generated signal values matter here: the error bound is a property of
    // the encode/decode asymmetry, so fast-check gets to hunt for the values
    // that maximize it rather than trusting a PRNG to stumble on them.
    fc.assert(
      fc.property(signalArb, (signal) => {
        const cap = instantiateWorklet(captureProcessorSource, {
          sampleRate: 16_000,
          bufferSeconds: 0.032,
        });
        cap.sendMessage({ event: "start" });
        const fed = feedQuanta(cap, signal, 40, { at: 0 });
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
        // 0x8000 — for arbitrary (non-dyadic) floats the asymmetry compounds
        // to at most two quantization steps.
        expect(maxErr).toBeLessThanOrEqual(2 / 0x80_00);
        expect(stops(play.posted)[0]?.stats.concealedSamples).toBe(0);
      }),
      { numRuns: 25 },
    );
  }, 60_000);
});
