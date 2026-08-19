// Copyright 2026 the AAI authors. MIT license.
/**
 * A bench for the playback jitter buffer: real TTS, the real worklet, a
 * deterministic clock, and one setting changed at a time.
 *
 * Why this exists. `PLAYBACK_JITTER_MS` and `PLAYBACK_REFILL_MS` are the two
 * numbers that decide whether a reply is heard as speech or as stutter, and
 * every test that touches them supplies its own arrival pattern:
 * `playback-processor.test.ts` hand-feeds quanta, and `audio-stress.test.ts`
 * records in its own header that its chunk sizes outrun the render loop by an
 * order of magnitude so the buffer "effectively never starves". Neither can
 * answer "is 400 the right number", because neither has ever seen how audio
 * actually arrives.
 *
 * So the bench replays a RECORDED reply (`_tts-trace-harness.ts`) through the
 * chain the audio really crosses:
 *
 *   provider frames (recorded arrival times)
 *     -> the server's bounded-lead pacer          <- MODELLED, see below
 *     -> a network profile (latency, jitter, stalls)
 *     -> the real playback worklet                <- `playbackProcessorSource`
 *     -> rendered PCM + the worklet's own stats
 *
 * Everything is virtual-time: the clock advances one 128-sample render quantum
 * per iteration, so a sweep of a hundred settings over a 30-second reply costs
 * seconds and gives byte-identical results every run. {@link renderToWav} is
 * the other half — the rendered output written where a human can listen to it,
 * because a concealment counter does not tell you whether a reply sounds
 * broken.
 *
 * **The pacer is a MODEL, and that is this bench's one fidelity gap.**
 * `createAudioPacer` (`aai/host/audio-pacer.ts`) is not on any published
 * subpath and this package may not import a sibling's internals, so
 * {@link pacedSends} is a transcription of its algorithm rather than the
 * algorithm. It is ~20 lines and reproduces the two properties the pacer's own
 * doc states — free flow until the lead ceiling, then one release per
 * `burstMs` — but a change to the real pacer will NOT fail this file. If the
 * pacer moves, re-read it against `pacedSends`. Exporting the real one and
 * deleting the model is the fix; it needs a non-test change.
 */

import { frameBytes, type TtsTrace } from "./_tts-trace-harness.ts";
import { instantiateWorklet } from "./_worklet-test-utils.ts";
import { playbackProcessorSource } from "./playback-processor.ts";

/** The render quantum every AudioWorkletProcessor is called with. */
export const QUANTUM = 128;

/** Sampling interval of {@link RenderResult.earMs}. */
export const EAR_SAMPLE_MS = 20;

/** PCM16 on both wires. */
const BYTES_PER_SAMPLE = 2;

/** One frame arriving at the client: when it lands, and what it carries. */
export type Delivery = { atMs: number; bytes: Uint8Array };

/**
 * How the server releases audio. Production values are
 * `CLIENT_AUDIO_LEAD_MS` (1000) and `PACER_BURST_MS` (200); they are
 * parameters here because they are half of what the bench is sweeping — the
 * client's cushion is the server's lead, so tuning the jitter buffer without
 * them is tuning one end of one number.
 */
export type PacerProfile = { leadMs: number; burstMs: number };

/** What the link does to a frame between the server and the ear. */
export type NetworkProfile = {
  name: string;
  /** One-way latency floor, ms. */
  latencyMs: number;
  /** Peak extra delay added on top, ms (0 = a perfectly even link). */
  jitterMs: number;
  /**
   * Freezes: `{ atMs, forMs }` pairs during which nothing is delivered, every
   * held frame landing at the end. This is what a jitter buffer is FOR, and
   * the only part of a profile that has to be scripted rather than sampled —
   * a stall is an event, not a distribution.
   */
  stalls?: { atMs: number; forMs: number }[];
  /**
   * Throughput ceiling in bits/s, or `Infinity`. Both legs are uncompressed
   * PCM16 (384 kbps down at 24 kHz), so a link that cannot carry the bitrate
   * cannot be fixed by any buffer — that claim is in the aai-ui guide and this
   * is what makes it measurable.
   */
  bitsPerSecond?: number;
};

/**
 * The worklet's one knob. It was two — a startup target and a refill target —
 * until this bench showed the startup one was redundant by construction; see
 * `PLAYBACK_FILL_MS`.
 */
export type PlaybackSettings = { fillMs: number };

/**
 * Deterministic pseudo-jitter. A profile has to be reproducible across a sweep
 * or two settings cannot be compared, so this is a hash of the frame index
 * rather than `Math.random()` — same schedule for every setting, every run.
 */
function jitterFor(index: number, peakMs: number): number {
  if (peakMs <= 0) return 0;
  // xorshift over the index: cheap, and its low bits are not correlated with
  // the frame number the way `index % n` is.
  let x = (index + 1) * 2_654_435_761;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return ((x >>> 0) / 0x1_00_00_00_00) * peakMs;
}

/**
 * Model the server's bounded-lead pacer over a trace's frames.
 *
 * A transcription of `createAudioPacer`, whose loop is: a frame is sent
 * immediately while the lead (everything sent so far, minus now) is under the
 * ceiling; otherwise it waits until the lead has drained `burstMs` below the
 * ceiling and then goes out with everything else the drain releases.
 */
export function pacedSends(trace: TtsTrace, pacer: PacerProfile): Delivery[] {
  const msPerByte = 1000 / (trace.sampleRate * BYTES_PER_SAMPLE);
  const burstMs = Math.min(pacer.burstMs, pacer.leadMs / 2);
  const out: Delivery[] = [];
  /** Wall time at which everything released so far finishes playing. */
  let playoutMs = 0;
  for (const frame of trace.frames) {
    const bytes = frameBytes(trace, frame);
    const durationMs = bytes.byteLength * msPerByte;
    // The frame cannot go out before it exists.
    let now = frame.tMs;
    // Nor before the lead has room. The real pacer wakes when the lead has
    // drained a burst below the ceiling and releases from there, so a frame
    // that arrives over the ceiling waits for exactly that instant.
    const leadAt = (t: number): number => Math.max(0, playoutMs - t);
    if (leadAt(now) > pacer.leadMs) now = playoutMs - (pacer.leadMs - burstMs);
    out.push({ atMs: now, bytes });
    playoutMs = Math.max(now, playoutMs) + durationMs;
  }
  return out;
}

/** Apply a network profile to the server's send schedule. */
export function overNetwork(sends: Delivery[], net: NetworkProfile): Delivery[] {
  const stalls = net.stalls ?? [];
  const bps = net.bitsPerSecond ?? Number.POSITIVE_INFINITY;
  const out: Delivery[] = [];
  /** When the link is next free — a finite bitrate serializes frames. */
  let linkFreeAt = 0;
  for (const [i, send] of sends.entries()) {
    let at = send.atMs + net.latencyMs + jitterFor(i, net.jitterMs);
    // A stall delivers everything held the moment it ends.
    for (const stall of stalls) {
      if (at >= stall.atMs && at < stall.atMs + stall.forMs) at = stall.atMs + stall.forMs;
    }
    if (Number.isFinite(bps)) {
      const transmitMs = (send.bytes.byteLength * 8 * 1000) / bps;
      at = Math.max(at, linkFreeAt) + transmitMs;
      linkFreeAt = at;
    }
    out.push({ atMs: at, bytes: send.bytes });
  }
  // A stall or a bitrate ceiling can reorder against the jitter draw; the
  // worklet's ring buffer is written in arrival order, so the schedule must be
  // sorted or the bench would test an out-of-order wire the socket cannot
  // produce (TCP delivers in order).
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** Everything one render of one setting produced. */
export type RenderResult = {
  /** The audio the ear actually received, at the context sample rate. */
  rendered: Float32Array;
  sampleRate: number;
  /** Ms from the first frame LEAVING the provider to the first audible sample. */
  timeToFirstAudioMs: number;
  /** The worklet's own report, as `onPlaybackStats` would receive it. */
  stats: {
    concealedSamples: number;
    silentConcealedSamples: number;
    concealmentEvents: number;
    silentConcealmentEvents: number;
  };
  /** Every concealment episode's length in ms, in order. */
  gapsMs: number[];
  /** `bufferedMs` values the worklet reported, as `playback_progress` would. */
  progressMs: number[];
  /**
   * Ground truth for the heard cursor: cumulative ms of the REPLY's own audio
   * the ear had received, sampled every {@link EAR_SAMPLE_MS}.
   *
   * Concealed samples are excluded — they are fabricated, not reply audio — so
   * this is exactly the quantity `heardMs()` in
   * `aai/host/transports/pipeline-heard.ts` estimates, which is what makes the
   * two comparable.
   */
  earMs: number[];
  /** How long the reply took to play out, first sample to last. */
  playedMs: number;
};

type PostedMessage = {
  event?: string;
  reason?: string;
  stats?: RenderResult["stats"];
  bufferedMs?: number;
};

/**
 * Tracks where audible audio starts, stops, and gaps, from the rendered output
 * alone.
 *
 * Split out of {@link renderSchedule} because the render loop was over the
 * complexity cap, and this is the half that is a state machine rather than a
 * clock: concealment before the turn's first real sample is exact zeros (the
 * worklet has nothing to extrapolate from and counts nothing), so the first
 * nonzero sample IS the start of playout and every silent quantum after it is a
 * gap.
 */
function createAudibleTracker(msPerQuantum: number) {
  const gapsMs: number[] = [];
  let firstQuantum = -1;
  let lastQuantum = -1;
  let gapQuanta = 0;
  let concealed = true;
  return {
    /**
     * Whether the quantum just observed was concealment (or pre-roll silence)
     * rather than the reply's own audio.
     */
    wasConcealed(): boolean {
      return concealed;
    },
    observe(out: Float32Array, q: number): void {
      if (out.some((v) => v !== 0)) {
        concealed = false;
        if (firstQuantum < 0) firstQuantum = q;
        lastQuantum = q;
        if (gapQuanta > 0) {
          gapsMs.push(gapQuanta * msPerQuantum);
          gapQuanta = 0;
        }
        return;
      }
      // Before the turn's first real sample the worklet emits exact zeros and
      // counts nothing; after it, a silent quantum is a concealed one. Either
      // way it is not reply audio.
      concealed = true;
      if (firstQuantum >= 0) gapQuanta++;
    },
    finish(): { gapsMs: number[]; timeToFirstAudioMs: number; playedMs: number } {
      if (gapQuanta > 0) gapsMs.push(gapQuanta * msPerQuantum);
      return {
        gapsMs,
        timeToFirstAudioMs: firstQuantum < 0 ? Number.NaN : firstQuantum * msPerQuantum,
        playedMs:
          lastQuantum < 0 ? 0 : (lastQuantum - Math.max(firstQuantum, 0) + 1) * msPerQuantum,
      };
    },
  };
}

/**
 * Sample how far into the REPLY the ear has got, every {@link EAR_SAMPLE_MS}.
 *
 * Its own object rather than four locals in the render loop, which was over the
 * complexity cap: this is bookkeeping on a second clock, and the loop's job is
 * the first one.
 */
function createEarRecorder(sampleRate: number) {
  const earMs: number[] = [];
  let realSamples = 0;
  let nextSampleMs = 0;
  return {
    earMs,
    /** Account for one rendered quantum, then emit any samples now due. */
    observe(rendered: number, concealed: boolean, tMs: number): void {
      if (!concealed) realSamples += rendered;
      while (nextSampleMs <= tMs) {
        earMs.push((realSamples / sampleRate) * 1000);
        nextSampleMs += EAR_SAMPLE_MS;
      }
    },
  };
}

/** Concatenate the rendered quanta into one buffer. */
function joinQuanta(chunks: Float32Array[]): Float32Array {
  const rendered = new Float32Array(chunks.length * QUANTUM);
  for (const [i, chunk] of chunks.entries()) rendered.set(chunk, i * QUANTUM);
  return rendered;
}

const NO_CONCEALMENT: RenderResult["stats"] = {
  concealedSamples: 0,
  silentConcealedSamples: 0,
  concealmentEvents: 0,
  silentConcealmentEvents: 0,
};

/**
 * Render one delivery schedule through the real playback worklet.
 *
 * The clock is the render loop itself: quantum `q` happens at
 * `q * QUANTUM / sampleRate` seconds, every delivery at or before that instant
 * is written first, and `done` is posted once the last frame has landed. That
 * is the ordering the audio thread really sees (`onmessage` and `process()`
 * never interleave), and it makes the whole render a pure function of the
 * schedule.
 */
export function renderSchedule(
  deliveries: Delivery[],
  opts: { sampleRate: number; settings: PlaybackSettings; maxSeconds?: number },
): RenderResult {
  const { sampleRate, settings } = opts;
  const harness = instantiateWorklet(
    playbackProcessorSource,
    { fillMs: settings.fillMs },
    sampleRate,
  );
  const msPerQuantum = (QUANTUM / sampleRate) * 1000;
  const maxQuanta = Math.ceil(((opts.maxSeconds ?? 300) * sampleRate) / QUANTUM);
  const lastDeliveryMs = deliveries.at(-1)?.atMs ?? 0;
  const audible = createAudibleTracker(msPerQuantum);

  const chunks: Float32Array[] = [];
  const ear = createEarRecorder(sampleRate);
  let next = 0;
  let donePosted = false;
  let stopped: PostedMessage | undefined;

  for (let q = 0; q < maxQuanta; q++) {
    const tMs = q * msPerQuantum;
    while (next < deliveries.length && (deliveries[next]?.atMs ?? 0) <= tMs) {
      harness.sendMessage({ event: "write", buffer: deliveries[next]?.bytes });
      next++;
    }
    // `done` is a turn boundary the host queues BEHIND its audio (the pacer's
    // `pushAfterAudio`), so it lands with the last frame and never before it.
    if (!donePosted && next >= deliveries.length && tMs >= lastDeliveryMs) {
      harness.sendMessage({ event: "done", turn: 1 });
      donePosted = true;
    }
    const out = new Float32Array(QUANTUM);
    harness.instance.process([], [[out]]);
    const posted = harness.posted.at(-1) as PostedMessage | undefined;
    if (posted?.event === "stop") {
      stopped = posted;
      break;
    }
    audible.observe(out, q);
    chunks.push(out);
    ear.observe(out.length, audible.wasConcealed(), tMs);
  }

  const progressMs = harness.posted
    .filter((m): m is PostedMessage => (m as PostedMessage)?.event === "progress")
    .map((m) => m.bufferedMs ?? 0);

  return {
    rendered: joinQuanta(chunks),
    sampleRate,
    stats: stopped?.stats ?? NO_CONCEALMENT,
    progressMs,
    earMs: ear.earMs,
    ...audible.finish(),
  };
}

/** One end-to-end run: trace + pacer + network + settings. */
export function runBench(opts: {
  trace: TtsTrace;
  pacer: PacerProfile;
  net: NetworkProfile;
  settings: PlaybackSettings;
}): RenderResult {
  const sends = pacedSends(opts.trace, opts.pacer);
  const deliveries = overNetwork(sends, opts.net);
  return renderSchedule(deliveries, {
    sampleRate: opts.trace.sampleRate,
    settings: opts.settings,
  });
}

/**
 * Score one render. Lower is better, and the WEIGHTS are the opinion in this
 * file — everything above is measurement.
 *
 * The three terms are not interchangeable:
 *
 * - **Startup latency** is paid on every single turn, so it is the term that
 *   compounds over a conversation.
 * - **Silent concealment** is an audible hole. Concealment that stays under
 *   the fade is a smear the ear largely forgives, which is why the worklet
 *   reports the two separately, so silence is weighted an order of magnitude
 *   higher than concealment in general.
 * - **Episode COUNT** matters independently of total length: one 300 ms pause
 *   reads as a network hiccup, where six 50 ms ones read as a broken codec.
 *   That is the whole finding behind the refill re-arm, so a score that
 *   summed milliseconds alone would rank the failure it was built to prevent
 *   as equal to the fix.
 */
export function scoreRender(r: RenderResult): { score: number; parts: Record<string, number> } {
  const rate = r.sampleRate;
  const concealedMs = (r.stats.concealedSamples / rate) * 1000;
  const silentMs = (r.stats.silentConcealedSamples / rate) * 1000;
  const parts = {
    startupMs: r.timeToFirstAudioMs,
    concealedMs: concealedMs - silentMs,
    silentMs,
    events: r.stats.concealmentEvents,
  };
  const score = parts.startupMs + parts.concealedMs * 2 + parts.silentMs * 20 + parts.events * 50;
  return { score, parts };
}

/** Minimal 16-bit PCM WAV, so a render can be listened to. */
export function toWav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (const [i, v] of samples.entries()) {
    const clamped = Math.max(-1, Math.min(1, v));
    data.writeInt16LE(Math.round(clamped * 0x7f_ff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
