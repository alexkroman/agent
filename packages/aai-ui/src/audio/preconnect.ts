// Copyright 2026 the AAI authors. MIT license.
/**
 * Pre-connect capture: the microphone opened before the session's audio rates
 * are known, and the resample that fits its buffer to the rate the server
 * then names. `createVoiceIO` (`audio/voice-io.ts`) is what takes it over.
 *
 * @module
 */

import { MIC_BUFFER_SECONDS, VOICE_CAPTURE_CONSTRAINTS } from "../types.ts";
import {
  assertGranted,
  type CaptureNode,
  createCaptureNode,
  releaseStreamOnFailure,
} from "./capture.ts";

/**
 * A microphone opened BEFORE the session's audio rates are known, buffering
 * what the caller says until {@link createVoiceIO} takes it over.
 *
 * The connect-time half of pre-connect audio: the server names its STT rate
 * only in its `config` frame, one handshake (and on the platform, possibly a
 * sandbox boot) after the user pressed start — and an eager caller is talking
 * by then. This captures at a guessed rate; {@link createVoiceIO} adopts it
 * whole when the guess was right and resamples the buffer when it was not.
 */
export type PreConnectCapture = {
  /** The rate this capture runs at — the guess. */
  readonly sampleRate: number;
  /** The granted microphone, handed to the {@link VoiceIO} that takes over. */
  readonly stream: MediaStream;
  /** The capture context, adopted as the path's own when the rate matches. */
  readonly ctx: AudioContext;
  /**
   * Adopt the running capture: flush the buffer to `onBuffered`, then route
   * every later frame to `onChunk` — synchronously, so nothing interleaves.
   */
  handOff(sinks: {
    onBuffered: (chunks: ArrayBuffer[]) => void;
    onChunk: (pcm16: ArrayBuffer) => void;
    onSilent?: (() => void) | undefined;
  }): { mic: MediaStreamAudioSourceNode; capture: CaptureNode };
  /**
   * Stop capturing (after the worklet's tail flush) and close the context,
   * keeping the stream: for a path at another rate. Never rejects.
   */
  detach(): Promise<{ chunks: ArrayBuffer[]; sampleRate: number }>;
  /** Release everything, stream included. Best-effort, idempotent. */
  close(): Promise<void>;
};

/**
 * Open a {@link PreConnectCapture}: ask for the microphone and start buffering
 * at `sampleRate`, keeping at most the latest `maxSeconds` — the most RECENT
 * audio rather than the first, so the buffer always runs contiguously into
 * the live stream that follows it.
 *
 * Rejects like {@link createVoiceIO} does (a denied prompt, a refused rate);
 * the caller falls back to opening the path the ordinary way.
 */
export async function openPreConnectCapture(opts: {
  sampleRate: number;
  captureWorkletSrc: string;
  maxSeconds: number;
}): Promise<PreConnectCapture> {
  const { sampleRate, captureWorkletSrc, maxSeconds } = opts;
  const ctx = new AudioContext({ sampleRate, latencyHint: "interactive" });
  const streamPromise = navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { ideal: "default" }, ...VOICE_CAPTURE_CONSTRAINTS },
  });
  let stream: MediaStream;
  try {
    [stream] = await Promise.all([
      streamPromise,
      ctx.resume(),
      ctx.audioWorklet.addModule(captureWorkletSrc),
    ]);
    assertGranted(ctx.sampleRate, sampleRate, "capture");
  } catch (err: unknown) {
    releaseStreamOnFailure(streamPromise);
    await ctx.close().catch(() => {
      /* nothing left to release */
    });
    throw err;
  }

  const maxBytes = Math.round(sampleRate * maxSeconds) * 2;
  let chunks: ArrayBuffer[] = [];
  let bytes = 0;
  let silent = false;
  let sinks: { onChunk: (pcm16: ArrayBuffer) => void; onSilent?: (() => void) | undefined } | null =
    null;
  const mic = ctx.createMediaStreamSource(stream);
  const capture = createCaptureNode(
    ctx,
    (pcm16) => {
      if (sinks) {
        sinks.onChunk(pcm16);
        return;
      }
      chunks.push(pcm16);
      bytes += pcm16.byteLength;
      while (bytes > maxBytes && chunks.length > 1) bytes -= chunks.shift()?.byteLength ?? 0;
    },
    () => {
      if (sinks) sinks.onSilent?.();
      else silent = true;
    },
  );
  mic.connect(capture.node);
  capture.start();

  /** Take the buffer, leaving it empty. */
  const takeChunks = (): ArrayBuffer[] => {
    const taken = chunks;
    chunks = [];
    bytes = 0;
    return taken;
  };
  let closed = false;
  const closeCtx = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    mic.disconnect();
    capture.node.disconnect();
    await ctx.close().catch((err: unknown) => {
      console.warn("AudioContext close failed:", err);
    });
  };

  return {
    sampleRate,
    stream,
    ctx,
    handOff(next) {
      sinks = next;
      const buffered = takeChunks();
      if (buffered.length > 0) next.onBuffered(buffered);
      if (silent) next.onSilent?.();
      return { mic, capture };
    },
    async detach() {
      // The stop's final flush lands in the buffer, so the tail is kept.
      await capture.stop();
      await closeCtx();
      return { chunks: takeChunks(), sampleRate };
    },
    async close() {
      if (!closed) await capture.stop();
      for (const t of stream.getTracks()) t.stop();
      await closeCtx();
    },
  };
}

/** Float32 → PCM16, clamped and scaled as the capture worklet does. */
function encodePcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = s < 0 ? s * 0x80_00 : s * 0x7f_ff;
  }
  return pcm.buffer;
}

/**
 * Convert buffered PCM16 from one rate to another with the browser's own
 * band-limited resampler (an `OfflineAudioContext` render), re-cut into
 * {@link MIC_BUFFER_SECONDS} chunks so the burst matches the live cadence.
 *
 * Never rejects: pre-connect audio is a bonus, and a browser that cannot
 * render it offline loses the bonus rather than the session.
 */
export async function resamplePcm16(
  chunks: ArrayBuffer[],
  fromRate: number,
  toRate: number,
): Promise<ArrayBuffer[]> {
  const total = chunks.reduce((n, c) => n + c.byteLength / 2, 0);
  if (total === 0) return [];
  if (fromRate === toRate) return chunks;
  try {
    const outLength = Math.round((total * toRate) / fromRate);
    const offline = new OfflineAudioContext(1, outLength, toRate);
    const input = offline.createBuffer(1, total, fromRate);
    const samples = input.getChannelData(0);
    let at = 0;
    for (const chunk of chunks) {
      for (const v of new Int16Array(chunk)) samples[at++] = v / 0x80_00;
    }
    const source = offline.createBufferSource();
    source.buffer = input;
    source.connect(offline.destination);
    source.start();
    const rendered = (await offline.startRendering()).getChannelData(0);
    const size = Math.max(1, Math.round(toRate * MIC_BUFFER_SECONDS));
    const out: ArrayBuffer[] = [];
    for (let start = 0; start < rendered.length; start += size) {
      out.push(encodePcm16(rendered.subarray(start, start + size)));
    }
    return out;
  } catch (err: unknown) {
    console.warn("[aai-ui] pre-connect audio dropped: resample failed", err);
    return [];
  }
}

/**
 * Wire and start a fresh capture node on `ctx`, first flushing any audio a
 * detached {@link PreConnectCapture} held, resampled to `ctx`'s rate.
 */
export async function startCapture(
  ctx: AudioContext,
  stream: MediaStream,
  opts: {
    onMicData: (pcm16: ArrayBuffer) => void;
    onMicSilent?: (() => void) | undefined;
    buffered: { chunks: ArrayBuffer[]; sampleRate: number } | null;
    onBuffered: (chunks: ArrayBuffer[]) => void;
  },
): Promise<{ mic: MediaStreamAudioSourceNode; capture: CaptureNode }> {
  const mic = ctx.createMediaStreamSource(stream);
  const capture = createCaptureNode(ctx, opts.onMicData, opts.onMicSilent);
  mic.connect(capture.node);
  if (opts.buffered) {
    const { chunks, sampleRate } = opts.buffered;
    const resampled = await resamplePcm16(chunks, sampleRate, ctx.sampleRate);
    if (resampled.length > 0) opts.onBuffered(resampled);
  }
  capture.start();
  return { mic, capture };
}
