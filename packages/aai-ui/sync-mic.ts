// Copyright 2026 the AAI authors. MIT license.
/**
 * WebRTC push-to-talk capture for the workflow run surface.
 *
 * Captures voice through `getUserMedia` under
 * {@link VOICE_CAPTURE_CONSTRAINTS} — echo cancellation only — and runs an
 * AudioWorklet that batches raw frames to the main thread; the caller's
 * button is the endpointing. Each recording becomes one `POST /sync` run.
 * No WebSocket anywhere on the path.
 *
 * The worklet module ships inline as a blob URL (same pattern as the
 * WebSocket path's worklets), so this path needs no separately-served
 * processor file. A blob URL rather than a data URI because the agent
 * page's CSP allows `script-src blob:` but not `data:` — a data-URI
 * module fails `addModule` with "Unable to load a worklet's module".
 */

import { VOICE_CAPTURE_CONSTRAINTS } from "./types.ts";

/** Default capture rate — what the STT providers expect. */
export const DEFAULT_SYNC_MIC_SAMPLE_RATE = 16_000;

/** ~128 ms at 16 kHz: few messages per second, fine-enough VAD granularity. */
export const CAPTURE_BATCH_SAMPLES = 2048;

/**
 * The capture processor: coalesces 128-sample render quanta into
 * {@link CAPTURE_BATCH_SAMPLES} batches and posts them (transferred, so no
 * per-batch copy). Inlined as source because it must be stringified into a
 * blob URL.
 *
 * `batch` is held as a field rather than re-read from the posted view:
 * `postMessage` with a transfer list detaches the buffer, so `out.length` is
 * 0 by the time the next buffer is allocated. Allocating a zero-length `buf`
 * from it made `n` 0 forever, so `read` stopped advancing and the render
 * thread spun inside `process()` posting empty chunks — the mic went
 * permanently deaf on its first flush.
 *
 * Exported for the worklet unit tests (`sync-mic-worklet.test.ts`), which
 * evaluate this source directly; it is not part of the package surface.
 */
export const CAPTURE_PROCESSOR_SRC = `
registerProcessor("aai-sync-capture", class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const batch = (options && options.processorOptions && options.processorOptions.batchSamples) || ${CAPTURE_BATCH_SAMPLES};
    this.batch = batch;
    this.buf = new Float32Array(batch);
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let read = 0;
    while (read < ch.length) {
      const n = Math.min(ch.length - read, this.buf.length - this.len);
      this.buf.set(ch.subarray(read, read + n), this.len);
      this.len += n;
      read += n;
      if (this.len === this.batch) {
        const out = this.buf;
        // Size the next buffer from this.batch, never from \`out\`: the
        // transfer below detaches out.buffer, so out.length reads 0 here.
        this.buf = new Float32Array(this.batch);
        this.len = 0;
        this.port.postMessage({ event: "chunk", samples: out }, [out.buffer]);
      }
    }
    return true;
  }
});
`;

/**
 * Blob-URL module for the capture processor (no served asset). Satisfies the
 * agent page's `script-src blob:` CSP, which rejects data-URI modules.
 */
export const CAPTURE_WORKLET_MODULE_URL = URL.createObjectURL(
  new Blob([CAPTURE_PROCESSOR_SRC], { type: "application/javascript" }),
);

/** Clamp-and-convert one Float32 capture batch to PCM16. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  let i = 0;
  for (const sample of samples) {
    const s = Math.max(-1, Math.min(1, sample));
    pcm[i++] = s < 0 ? s * 0x80_00 : s * 0x7f_ff;
  }
  return pcm;
}

/** Hold-to-record handle returned by {@link createPttRecorder}. */
export type PttRecorder = {
  /** Open the mic (first call) and start collecting frames. */
  start(): Promise<void>;
  /** Stop collecting and return everything recorded since `start()` as PCM16. */
  stop(): Promise<Int16Array>;
  /** Release the mic and the AudioContext. */
  close(): Promise<void>;
};

/**
 * Push-to-talk recorder: `getUserMedia` voice capture feeding the capture
 * worklet, with the caller's button as the endpointing. Recording runs
 * exactly between `start()` and `stop()`; the mic stays open across presses
 * until `close()`.
 *
 * @public
 */
export function createPttRecorder(sampleRate = DEFAULT_SYNC_MIC_SAMPLE_RATE): PttRecorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let chunks: Float32Array[] = [];
  let recording = false;

  async function ensureOpen(): Promise<void> {
    if (ctx) return;
    const streamPromise = navigator.mediaDevices.getUserMedia({
      audio: VOICE_CAPTURE_CONSTRAINTS,
    });
    const audioCtx = new AudioContext({ sampleRate, latencyHint: "interactive" });
    try {
      const [media] = await Promise.all([
        streamPromise,
        audioCtx.resume(),
        audioCtx.audioWorklet.addModule(CAPTURE_WORKLET_MODULE_URL),
      ]);
      stream = media;
    } catch (err) {
      // Release the mic if it was granted while another step failed.
      void streamPromise
        .then((s) => {
          for (const t of s.getTracks()) t.stop();
        })
        .catch(() => {
          /* rejected with the same error */
        });
      await audioCtx.close().catch(() => {
        /* already closing */
      });
      throw err;
    }
    const workletNode = new AudioWorkletNode(audioCtx, "aai-sync-capture", {
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { batchSamples: CAPTURE_BATCH_SAMPLES },
    });
    workletNode.port.onmessage = (e: MessageEvent) => {
      const data = e.data as { event?: string; samples?: Float32Array };
      if (recording && data.event === "chunk" && data.samples) chunks.push(data.samples);
    };
    audioCtx.createMediaStreamSource(stream).connect(workletNode);
    ctx = audioCtx;
    node = workletNode;
  }

  return {
    async start() {
      await ensureOpen();
      chunks = [];
      recording = true;
    },
    async stop() {
      // Give the worklet one beat to post the batch in flight; anything
      // still inside a partial batch (<~130ms) is dropped.
      await new Promise((r) => setTimeout(r, 150));
      recording = false;
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Float32Array(total);
      let offset = 0;
      for (const c of chunks) {
        all.set(c, offset);
        offset += c.length;
      }
      chunks = [];
      return floatToPcm16(all);
    },
    async close() {
      recording = false;
      node?.disconnect();
      if (stream) for (const t of stream.getTracks()) t.stop();
      await ctx?.close().catch(() => {
        /* already closed */
      });
      ctx = null;
      node = null;
      stream = null;
    },
  };
}
