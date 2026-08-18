// Copyright 2026 the AAI authors. MIT license.
/**
 * Capture and replay of REAL TTS arrival timing.
 *
 * The playback worklet's tuning question — how deep should
 * `PLAYBACK_JITTER_MS` be — is entirely a question about how unevenly audio
 * arrives, and every existing test answers it with a generated arrival pattern.
 * `audio-stress.test.ts` says so itself: its chunk-size arbitrary averages
 * ~750 samples against 128 consumed per render, so writes outrun renders by an
 * order of magnitude and the buffer effectively never starves. A jitter buffer
 * tuned against that is tuned against nothing.
 *
 * So a trace is a recording of one real reply as the provider actually emitted
 * it: PCM16 bytes plus the millisecond each frame ARRIVED, relative to the
 * first. Replayed through the real pacer and the real worklet, that makes the
 * tuning question measurable and repeatable — the same reply, the same
 * arrival pattern, one setting changed.
 *
 * Two halves, deliberately separate:
 *
 * - {@link captureTtsTrace} needs a live provider and an API key. It runs once,
 *   by hand (`AAI_CAPTURE_TTS_TRACE=1`), and commits its result.
 * - {@link readTtsTrace} needs neither, so every test that CONSUMES a trace is
 *   keyless and offline.
 *
 * The bytes live beside the JSON rather than inside it: base64 in a fixture
 * inflates ~1 MB of PCM by a third and makes the file unreadable in a diff,
 * where a `.pcm` sidecar is `ffplay`-able and reviewed by its length alone.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sleep } from "@alexkroman1/aai/internal";

/**
 * The rate a trace is captured at. Mirrors the SDK's own
 * `DEFAULT_TTS_SAMPLE_RATE`, which is not reachable from any published
 * subpath — a test harness may not widen one to read a number.
 */
const TRACE_SAMPLE_RATE = 24_000;

/** One provider audio frame, with the moment it arrived. */
export type TraceFrame = {
  /** Arrival time in ms, relative to the first frame of the reply. */
  tMs: number;
  /** Byte offset of this frame's PCM16 in the sidecar. */
  offset: number;
  /** Byte length of this frame's PCM16. */
  length: number;
};

/** A recorded reply: what the provider sent, and when. */
export type TtsTrace = {
  /** Sample rate of the PCM16 in the sidecar. */
  sampleRate: number;
  /** Provider kind and voice, so a trace names the thing it recorded. */
  provider: string;
  voice: string;
  /** The reply text that was synthesized. */
  text: string;
  /** Ms from the first `sendText` to the first audio frame. */
  firstAudioMs: number;
  /** Ms from the first `sendText` to `done`. */
  doneMs: number;
  frames: TraceFrame[];
  /** All frames' PCM16, concatenated in arrival order. */
  pcm: Int16Array;
};

/** The serializable half — everything but the samples. */
type TraceIndex = Omit<TtsTrace, "pcm">;

/**
 * Total audio duration in ms. Not the same as {@link TtsTrace.doneMs}: a
 * provider that synthesizes faster than real time produces more audio than the
 * wall clock it took to produce it, and the RATIO of the two is the whole
 * reason a jitter buffer can ever fill.
 */
export function traceAudioMs(trace: TtsTrace): number {
  return (trace.pcm.length / trace.sampleRate) * 1000;
}

/**
 * The slice of the SDK's `TtsSession` a capture drives. Declared structurally
 * so the harness needs no host-only type import: a real session satisfies it.
 */
export type CapturableTtsSession = {
  sendText(text: string): void;
  flush(): void;
  on(event: "audio", fn: (pcm: Int16Array) => void): unknown;
  on(event: "done", fn: () => void): unknown;
  on(event: "error", fn: (err: { message?: string }) => void): unknown;
  close(): Promise<void>;
};

/**
 * Open a real TTS session, synthesize `text`, and record every frame's arrival.
 *
 * The text is sent the way the PIPELINE sends it — as deltas, with a final
 * `flush()` — because the AssemblyAI adapter segments on what it receives and
 * `Generate` only buffers until a `Flush`. Handing it the whole reply in one
 * call would record a different arrival pattern from the one a real turn
 * produces (see `providers/tts/assemblyai-segment.ts`).
 */
export async function captureTtsTrace(opts: {
  text: string;
  /**
   * Opens the real provider session. INJECTED rather than resolved here: the
   * resolver (`aai`'s `host/providers/resolve.ts`) is not on any published
   * subpath, and this package may not import a sibling's internals. The caller
   * that has one is the capture runner, which is not part of the package.
   */
  open: (o: { sampleRate: number; signal: AbortSignal }) => Promise<CapturableTtsSession>;
  /** LLM-shaped deltas. Defaults to splitting `text` on word boundaries. */
  deltas?: string[];
  /** Recorded into the trace so a fixture names the voice it captured. */
  voice?: string;
  provider?: string;
  sampleRate?: number;
  /**
   * Gap between deltas, in ms. **Set this to represent a real turn.**
   *
   * Sending every delta in one burst is what a capture does by default, and for
   * the PLAYBACK question that is harmless — the pacer reshapes arrival anyway.
   * For anything about SEGMENTATION it invalidates the measurement outright: the
   * segmenter is handed the whole reply before it makes its first cut, so
   * time-to-first-audio collapses to the service's own latency (~40 ms measured)
   * and every segmentation rule scores the same. An LLM streams at ~30 ms a
   * delta, which is what the segmenter really sees.
   */
  deltaIntervalMs?: number;
  /** Hard cap, so a provider that never sends `done` cannot hang the capture. */
  timeoutMs?: number;
}): Promise<TtsTrace> {
  const sampleRate = opts.sampleRate ?? TRACE_SAMPLE_RATE;
  const voice = opts.voice ?? "jane";
  const controller = new AbortController();
  const session = await opts.open({ sampleRate, signal: controller.signal });

  const chunks: Int16Array[] = [];
  const frames: Omit<TraceFrame, "offset">[] = [];
  let offsetSamples = 0;
  let firstAudioMs = -1;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const t0 = performance.now();
  const at = (): number => performance.now() - t0;

  session.on("audio", (pcm) => {
    const tMs = at();
    if (firstAudioMs < 0) firstAudioMs = tMs;
    // Copy: the adapter may reuse its decode buffer between frames.
    chunks.push(new Int16Array(pcm));
    frames.push({ tMs, length: pcm.length * 2 });
    offsetSamples += pcm.length;
  });
  session.on("done", () => resolve());
  session.on("error", (err) => reject(new Error(`tts error: ${err.message ?? String(err)}`)));

  const deltas = opts.deltas ?? splitIntoDeltas(opts.text);
  for (const delta of deltas) {
    session.sendText(delta);
    if (opts.deltaIntervalMs) await sleep(opts.deltaIntervalMs);
  }
  session.flush();

  const timeout = setTimeout(
    () => reject(new Error("tts capture timed out before 'done'")),
    opts.timeoutMs ?? 60_000,
  );
  try {
    await promise;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await session.close().catch(() => {
      /* the capture already has what it came for */
    });
  }

  const pcm = new Int16Array(offsetSamples);
  let write = 0;
  let byteOffset = 0;
  const indexed: TraceFrame[] = [];
  for (const [i, chunk] of chunks.entries()) {
    pcm.set(chunk, write);
    write += chunk.length;
    const frame = frames[i];
    if (frame === undefined) continue;
    indexed.push({ tMs: round(frame.tMs), offset: byteOffset, length: frame.length });
    byteOffset += frame.length;
  }

  return {
    sampleRate,
    provider: opts.provider ?? "assemblyai",
    voice,
    text: opts.text,
    firstAudioMs: round(firstAudioMs),
    doneMs: round(at()),
    frames: indexed,
    pcm,
  };
}

/**
 * Split a reply into LLM-shaped deltas: a few words at a time, which is what
 * `streamText` emits and therefore what the adapter's segmenter sees.
 */
export function splitIntoDeltas(text: string, wordsPer = 3): string[] {
  const words = text.split(/(\s+)/).filter((w) => w.length > 0);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += wordsPer * 2) {
    out.push(words.slice(i, i + wordsPer * 2).join(""));
  }
  return out;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Where a trace's two files live, given its directory and name. */
export function tracePaths(dir: string, name: string): { index: string; pcm: string } {
  return { index: path.join(dir, `${name}.json`), pcm: path.join(dir, `${name}.pcm`) };
}

export async function writeTtsTrace(dir: string, name: string, trace: TtsTrace): Promise<void> {
  const { index, pcm } = tracePaths(dir, name);
  await mkdir(dir, { recursive: true });
  const { pcm: samples, ...rest } = trace;
  await writeFile(index, `${JSON.stringify(rest, null, 2)}\n`);
  await writeFile(pcm, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
}

/** Whether both halves of a trace are present, for a `skipIf` that announces. */
export function hasTtsTrace(dir: string, name: string): boolean {
  const { index, pcm } = tracePaths(dir, name);
  return existsSync(index) && existsSync(pcm);
}

export async function readTtsTrace(dir: string, name: string): Promise<TtsTrace> {
  const { index, pcm } = tracePaths(dir, name);
  return assemble(await readFile(index, "utf8"), await readFile(pcm));
}

/**
 * The same read, synchronously.
 *
 * A `describe` body may not `await` — vitest collects it synchronously — so a
 * suite whose every case shares one trace has no other way to load it once.
 * Reading it per `test` instead would decode 375 KiB of PCM ten times over for
 * a value that is immutable.
 */
export function readTtsTraceSync(dir: string, name: string): TtsTrace {
  const { index, pcm } = tracePaths(dir, name);
  return assemble(readFileSync(index, "utf8"), readFileSync(pcm));
}

function assemble(json: string, bytes: Buffer): TtsTrace {
  const parsed = JSON.parse(json) as TraceIndex;
  // A Buffer's byteOffset is not guaranteed to be even, and Int16Array demands
  // 2-byte alignment — copy rather than wrap when it is not.
  const aligned = bytes.byteOffset % 2 === 0 ? bytes : Buffer.from(bytes);
  return {
    ...parsed,
    pcm: new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2),
  };
}

/** The PCM16 bytes of one frame, as the wire would carry them. */
export function frameBytes(trace: TtsTrace, frame: TraceFrame): Uint8Array {
  return new Uint8Array(trace.pcm.buffer, trace.pcm.byteOffset + frame.offset, frame.length);
}
