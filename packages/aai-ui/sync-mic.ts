// Copyright 2026 the AAI authors. MIT license.
/**
 * WebRTC push-to-talk capture for the workflow run surface.
 *
 * Captures voice through `getUserMedia` under
 * {@link VOICE_CAPTURE_CONSTRAINTS} — echo cancellation only — and runs the
 * same capture worklet as the WebSocket mic, through the shared
 * {@link createCaptureNode} wiring: one processor, one protocol. The
 * caller's button is the endpointing; each recording becomes one
 * `POST /sync` run. No WebSocket anywhere on the path.
 */

import {
  assertGranted,
  type CaptureNode,
  createCaptureNode,
  releaseStreamOnFailure,
} from "./audio.ts";
import { DEFAULT_STT_SAMPLE_RATE, VOICE_CAPTURE_CONSTRAINTS } from "./types.ts";
import captureWorkletUrl from "./worklets/capture-processor.ts";

/** Default capture rate — what the STT providers expect. */
export const DEFAULT_SYNC_MIC_SAMPLE_RATE = DEFAULT_STT_SAMPLE_RATE;

/** The shared capture worklet's blob-URL module (CSP rationale: `worklets/_module-url.ts`). */
export const CAPTURE_WORKLET_MODULE_URL = captureWorkletUrl;

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
 * Push-to-talk recorder: `getUserMedia` voice capture feeding the shared
 * capture worklet, with the caller's button as the endpointing. Recording
 * runs exactly between `start()` and `stop()` — the worklet only accumulates
 * between its 'start' and 'stop' messages, so audio from before the press
 * can never leak into a clip. The mic stays open across presses until
 * `close()`.
 *
 * @public
 */
export function createPttRecorder(sampleRate = DEFAULT_SYNC_MIC_SAMPLE_RATE): PttRecorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let capture: CaptureNode | null = null;
  let chunks: Int16Array[] = [];
  /** In-flight stop(), so a rapid re-press serializes behind it. */
  let pendingStop: Promise<Int16Array> | null = null;
  let closed = false;

  async function ensureOpen(): Promise<void> {
    if (closed) throw new Error("Recorder is closed");
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
      // The clip is tagged with `sampleRate` on the wire, so a context the
      // browser silently runs at another rate would ship wrong-speed audio.
      assertGranted(audioCtx.sampleRate, sampleRate, "capture");
      // close() while this open was in flight: release what we just acquired
      // rather than assigning a mic nothing can reach anymore.
      if (closed) throw new Error("Recorder closed during open");
      stream = media;
    } catch (err) {
      releaseStreamOnFailure(streamPromise);
      await audioCtx.close().catch(() => {
        /* already closing */
      });
      throw err;
    }
    const node = createCaptureNode(audioCtx, (buffer) => {
      chunks.push(new Int16Array(buffer));
    });
    audioCtx.createMediaStreamSource(stream).connect(node.node);
    ctx = audioCtx;
    capture = node;
  }

  async function drainStop(): Promise<Int16Array> {
    // stop() with no completed start(): nothing was ever recorded, and no
    // 'stopped' ack will come — return immediately instead of waiting out
    // the ack timeout.
    if (!capture) return new Int16Array(0);
    await capture.stop();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const c of chunks) {
      pcm.set(c, offset);
      offset += c.length;
    }
    chunks = [];
    return pcm;
  }

  return {
    async start() {
      // A press during the previous release's stop-ack wait must not steal
      // its chunks (or be silenced by its completion) — wait it out first.
      if (pendingStop) {
        await pendingStop.catch(() => {
          /* the failed stop already surfaced to its own caller */
        });
      }
      await ensureOpen();
      // Discard any tail chunk a dead-worklet ack timeout left behind — the
      // worklet gates accumulation, so on every healthy path this is empty.
      chunks = [];
      capture?.start();
    },
    stop() {
      const done = drainStop().finally(() => {
        if (pendingStop === done) pendingStop = null;
      });
      pendingStop = done;
      return done;
    },
    async close() {
      closed = true;
      capture?.node.disconnect();
      if (stream) for (const t of stream.getTracks()) t.stop();
      await ctx?.close().catch(() => {
        /* already closed */
      });
      ctx = null;
      capture = null;
      stream = null;
    },
  };
}
