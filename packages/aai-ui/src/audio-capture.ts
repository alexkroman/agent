// Copyright 2025 the AAI authors. MIT license.
/**
 * The capture half's primitives, shared by the audio path (`audio.ts`) and
 * the pre-connect capture (`audio-preconnect.ts`): the rate assertion, the
 * failed-init release, and the capture worklet node's port protocol.
 *
 * @module
 */
import { CAPTURE_STOP_ACK_TIMEOUT_MS } from "./types.ts";

/**
 * Throw unless the browser honored a requested context sample rate. The
 * requested rates are never advisory: captured audio is tagged with the
 * requested rate on the wire, so a context running at some other rate ships
 * audio that only sounds like speech to the wrong decoder. Every capture
 * path must call this after context creation.
 */
export function assertGranted(granted: number, requested: number, side: string): void {
  if (granted === requested) return;
  throw new Error(
    `Browser refused the ${side} sample rate: asked for ${requested} Hz, got ${granted} Hz`,
  );
}

/**
 * The error a dead worklet processor reports.
 *
 * A processor exception permanently kills the node — no further messages or
 * audio will ever arrive — so both sides log it and hand it on. One spelling of
 * that, because the pair differed only in the word "capture"/"playback" and in
 * what the playback side has to settle afterwards.
 */
export function workletCrash(side: "capture" | "playback"): Error {
  const err = new Error(`Audio ${side} worklet crashed`);
  console.error("[aai-ui]", err.message);
  return err;
}

/**
 * Release a microphone that was (or later gets) granted while another init
 * step failed; if `getUserMedia` itself rejected, this is a no-op. Without
 * it, a mic granted after a failed init keeps the browser's recording
 * indicator lit with no way to turn it off.
 */
export function releaseStreamOnFailure(streamPromise: Promise<MediaStream>): void {
  void streamPromise
    .then((s) => {
      for (const t of s.getTracks()) t.stop();
    })
    .catch(() => {
      /* rejected with the same error */
    });
}

/** Handle to one capture worklet node (`worklets/capture-processor.ts`). */
export type CaptureNode = {
  node: AudioWorkletNode;
  /** Begin accumulating — the worklet gates capture on its start/stop protocol. */
  start(): void;
  /**
   * Stop accumulating and wait (bounded by {@link CAPTURE_STOP_ACK_TIMEOUT_MS})
   * for the 'stopped' ack that follows the worklet's final flush, so the tail
   * of speech reaches `onChunk` before the node is torn down.
   */
  stop(): Promise<void>;
};

/**
 * Wire one capture worklet node: node construction, the chunk/silent/stopped
 * port protocol, and the stop→ack handshake. No `processorOptions`: the
 * worklet reads the context rate from its global scope (callers assert the
 * granted rate first) and owns its own batching default — re-spelling
 * defaults caller-side is drift.
 */
export function createCaptureNode(
  ctx: AudioContext,
  onChunk: (pcm16: ArrayBuffer) => void,
  onSilent?: () => void,
): CaptureNode {
  const node = new AudioWorkletNode(ctx, "capture-processor", {
    channelCount: 1,
    channelCountMode: "explicit",
  });
  let onStopped: (() => void) | null = null;
  node.port.onmessage = (e: MessageEvent) => {
    const d = e.data as { event?: string; buffer?: ArrayBuffer };
    if (d.event === "chunk" && d.buffer) {
      onChunk(d.buffer);
    } else if (d.event === "silent") {
      onSilent?.();
    } else if (d.event === "stopped") {
      onStopped?.();
      onStopped = null;
    }
  };
  return {
    node,
    start() {
      node.port.postMessage({ event: "start" });
    },
    stop() {
      // `Promise.withResolvers` rather than an executor: the resolver has to
      // outlive the constructor call — it is stored on `onStopped` for the port
      // handler above — so an executor only exists to hoist it back out.
      const { promise, resolve } = Promise.withResolvers<void>();
      const cap = setTimeout(resolve, CAPTURE_STOP_ACK_TIMEOUT_MS);
      onStopped = () => {
        clearTimeout(cap);
        resolve();
      };
      node.port.postMessage({ event: "stop" });
      return promise;
    },
  };
}
