// Copyright 2026 the AAI authors. MIT license.
/**
 * WebRTC microphone capture for sync mode.
 *
 * Captures voice through `getUserMedia` with the WebRTC voice-processing
 * constraints (echo cancellation, noise suppression, auto gain — the
 * processing that makes the energy VAD in `sync-vad.ts` reliable), runs an
 * AudioWorklet that batches raw frames to the main thread, feeds them
 * through the utterance detector, and hands each completed utterance to
 * the sync session as one HTTP turn. No WebSocket anywhere on the path.
 *
 * The worklet module ships inline as a blob URL (same pattern as the
 * WebSocket path's worklets), so sync mode needs no separately-served
 * processor file. A blob URL rather than a data URI because the agent
 * page's CSP allows `script-src blob:` but not `data:` — a data-URI
 * module fails `addModule` with "Unable to load a worklet's module".
 */

import { errorMessage } from "@alexkroman1/aai";
import type { SyncSession } from "./sync-session.ts";
import {
  createUtteranceDetector,
  type UtteranceDetector,
  type UtteranceDetectorOptions,
} from "./sync-vad.ts";

/** Default capture rate — what the STT providers expect. */
export const DEFAULT_SYNC_MIC_SAMPLE_RATE = 16_000;

/** ~128 ms at 16 kHz: few messages per second, fine-enough VAD granularity. */
const CAPTURE_BATCH_SAMPLES = 2048;

/**
 * The capture processor: coalesces 128-sample render quanta into
 * {@link CAPTURE_BATCH_SAMPLES} batches and posts them (transferred, so no
 * per-batch copy). Inlined as source because it must be stringified into a
 * blob URL.
 */
const CAPTURE_PROCESSOR_SRC = `
registerProcessor("aai-sync-capture", class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const batch = (options && options.processorOptions && options.processorOptions.batchSamples) || ${CAPTURE_BATCH_SAMPLES};
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
      if (this.len === this.buf.length) {
        const out = this.buf;
        this.port.postMessage({ event: "chunk", samples: out }, [out.buffer]);
        this.buf = new Float32Array(out.length);
        this.len = 0;
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

/** Configuration for {@link startSyncMicrophone}. */
export type SyncMicrophoneOptions = {
  /** The session each completed utterance is sent through. */
  session: Pick<SyncSession, "sendPcm16">;
  /** Capture/STT sample rate. Defaults to {@link DEFAULT_SYNC_MIC_SAMPLE_RATE}. */
  sampleRate?: number | undefined;
  /** VAD tuning overrides (see {@link UtteranceDetectorOptions}). */
  vad?: Omit<UtteranceDetectorOptions, "sampleRate"> | undefined;
  /** Speech onset confirmed — a turn will follow once the user pauses. */
  onSpeechStart?: (() => void) | undefined;
  /** An utterance was endpointed and its turn dispatched. */
  onSpeechEnd?: (() => void) | undefined;
  /** Capture or turn failure (the mic keeps running unless stopped). */
  onError?: ((err: Error) => void) | undefined;
};

/** Live microphone handle returned by {@link startSyncMicrophone}. */
export type SyncMicrophone = {
  /** True while the detector is inside an utterance. */
  readonly speaking: boolean;
  /** Release the mic, the AudioContext, and flush a trailing utterance. */
  stop(): Promise<void>;
};

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
 * Push-to-talk recorder on the same WebRTC capture pipeline as
 * {@link startSyncMicrophone} — `getUserMedia` voice processing feeding the
 * capture worklet — minus the VAD: the caller's button is the endpointing.
 * Recording runs exactly between `start()` and `stop()`; the mic stays open
 * across presses until `close()`.
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
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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

/**
 * Open the microphone and stream endpointed utterances into a sync session.
 *
 * @throws If microphone access is denied or worklet registration fails.
 */
export async function startSyncMicrophone(opts: SyncMicrophoneOptions): Promise<SyncMicrophone> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SYNC_MIC_SAMPLE_RATE;
  const detector: UtteranceDetector = createUtteranceDetector({ sampleRate, ...opts.vad });
  const fail = (err: unknown): void => {
    opts.onError?.(err instanceof Error ? err : new Error(errorMessage(err)));
  };

  // WebRTC voice capture: the browser's voice-processing pipeline cleans the
  // signal before the energy VAD ever sees it.
  const streamPromise = navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const ctx = new AudioContext({ sampleRate, latencyHint: "interactive" });
  let stream: MediaStream;
  try {
    [stream] = await Promise.all([
      streamPromise,
      ctx.resume(),
      ctx.audioWorklet.addModule(CAPTURE_WORKLET_MODULE_URL),
    ]);
  } catch (err) {
    // Release the mic if it was granted while another step failed.
    void streamPromise
      .then((s) => {
        for (const t of s.getTracks()) t.stop();
      })
      .catch(() => {
        /* rejected with the same error */
      });
    await ctx.close().catch(() => {
      /* already closing */
    });
    throw err;
  }

  const mic = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "aai-sync-capture", {
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions: { batchSamples: CAPTURE_BATCH_SAMPLES },
  });
  mic.connect(node);

  let stopped = false;
  let wasSpeaking = false;

  function dispatch(utterance: Int16Array | null): void {
    if (!utterance) return;
    opts.onSpeechEnd?.();
    opts.session.sendPcm16(utterance, sampleRate).catch(fail);
  }

  function handleFrame(samples: Float32Array): void {
    if (stopped) return;
    dispatch(detector.push(floatToPcm16(samples)));
    if (detector.speaking && !wasSpeaking) opts.onSpeechStart?.();
    wasSpeaking = detector.speaking;
  }

  node.port.onmessage = (e: MessageEvent) => {
    const data = e.data as { event?: string; samples?: Float32Array };
    if (data.event === "chunk" && data.samples) handleFrame(data.samples);
  };
  // A processor exception permanently kills the worklet — no further audio
  // will ever arrive. Surface it rather than staying silently deaf.
  node.onprocessorerror = () => fail(new Error("Sync capture worklet crashed"));

  return {
    get speaking() {
      return detector.speaking;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      // A trailing utterance the hangover never closed still counts.
      dispatch(detector.flush());
      mic.disconnect();
      node.disconnect();
      for (const t of stream.getTracks()) t.stop();
      await ctx.close().catch(() => {
        /* already closed */
      });
    },
  };
}
