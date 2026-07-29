// Copyright 2026 the AAI authors. MIT license.

/**
 * File-upload transcription for the session core (`sendAudioFile`).
 *
 * Split out of `session-core.ts`: this module owns the decode → frame →
 * reliable-send pipeline for uploaded audio, plus the two guards that keep
 * it exclusive — an in-flight lock (no second upload, no mic start
 * mid-upload) and an epoch that in-flight sends compare against so a
 * reset/close/reconnect abandons them instead of streaming a stale clip
 * into the fresh session.
 */

import { FILE_UPLOAD_CHUNK_BYTES, WS_OPEN } from "@alexkroman1/aai";
import type { ClientMessage } from "@alexkroman1/aai/protocol";
import { MAX_SYNC_AUDIO_SECONDS } from "@alexkroman1/aai/stt";
import type { ConnState, SessionSnapshot } from "./session-core-types.ts";
import { FILE_SEND_BACKOFF_MS, MIC_SEND_MAX_BUFFERED_BYTES } from "./types.ts";

/** Handle to the upload pipeline, owned by one session core. */
export type UploadSender = {
  /** See {@link SessionCore.sendAudioFile}. */
  sendAudioFile(file: Blob): Promise<void>;
  /** True while an upload is decoding or streaming — the mic must stay off. */
  inFlight(): boolean;
  /** Invalidate any in-flight upload (reset / close / reconnect). */
  discard(): void;
};

export function createUploadSender(deps: {
  conn: ConnState;
  getSnapshot: () => SessionSnapshot;
  sendJson: (msg: ClientMessage) => void;
}): UploadSender {
  const { conn, getSnapshot, sendJson } = deps;

  /** True while a `sendAudioFile` upload is decoding or streaming. Blocks the
   *  mic (and a second upload) so file bytes never interleave with live audio. */
  let uploadInFlight = false;
  /** Bumped whenever conversation/connection state is discarded (reset, close,
   *  reconnect). An in-flight upload compares against it between chunks and
   *  aborts instead of streaming a stale clip into the fresh session. */
  let uploadEpoch = 0;

  /** Stream `bytes` to the socket in chunks, waiting out backpressure.
   *  Unlike live mic frames (dropped under backpressure — stale speech is
   *  worthless), file audio must arrive completely. Aborts if the connection
   *  closes or the session is reset (`epoch` moves on) between chunks. */
  async function sendBytesReliably(bytes: Uint8Array, epoch: number): Promise<void> {
    for (let i = 0; i < bytes.byteLength; i += FILE_UPLOAD_CHUNK_BYTES) {
      while (
        epoch === uploadEpoch &&
        conn.ws &&
        conn.ws.readyState === WS_OPEN &&
        conn.ws.bufferedAmount > MIC_SEND_MAX_BUFFERED_BYTES
      ) {
        await new Promise((r) => setTimeout(r, FILE_SEND_BACKOFF_MS));
      }
      if (epoch !== uploadEpoch) {
        throw new Error("sendAudioFile: session was reset mid-send");
      }
      if (!conn.ws || conn.ws.readyState !== WS_OPEN) {
        throw new Error("sendAudioFile: connection closed mid-send");
      }
      conn.ws.send(bytes.subarray(i, i + FILE_UPLOAD_CHUNK_BYTES) as unknown as ArrayBuffer);
    }
  }

  /** Validate that an upload may start; returns the session's ready config. */
  function assertUploadReady(): NonNullable<ConnState["readyConfig"]> {
    const cfg = conn.readyConfig;
    if (!(cfg && conn.ws) || conn.ws.readyState !== WS_OPEN) {
      throw new Error("sendAudioFile: session is not connected");
    }
    const snap = getSnapshot();
    if (snap.audioOut) {
      throw new Error(
        "sendAudioFile is only available in text-only sessions (tts: none()) — voice sessions stream the microphone instead",
      );
    }
    if (snap.recording) {
      throw new Error("sendAudioFile: stop recording before uploading a file");
    }
    if (uploadInFlight) {
      throw new Error("sendAudioFile: another upload is already in progress");
    }
    return cfg;
  }

  async function sendAudioFile(file: Blob): Promise<void> {
    const cfg = assertUploadReady();
    uploadInFlight = true;
    const epoch = uploadEpoch;
    try {
      const { decodeAudioToPcm16 } = await import("./audio.ts");
      const clip = await decodeAudioToPcm16(await file.arrayBuffer(), cfg.sampleRate);
      // Decoding awaited: re-check that nothing started the mic or reset the
      // session meanwhile — mixed streams would corrupt both.
      if (getSnapshot().recording || conn.audioSetupInFlight) {
        throw new Error("sendAudioFile: stop recording before uploading a file");
      }
      if (epoch !== uploadEpoch) {
        throw new Error("sendAudioFile: session was reset mid-send");
      }
      // Short clips take the one-shot path: the server transcribes the whole
      // upload in a single request (AssemblyAI's Sync API — the preferred
      // endpoint for files under two minutes) instead of replaying it through
      // the realtime socket. No endpointing, so no trailing-silence padding.
      if (clip.length / cfg.sampleRate <= MAX_SYNC_AUDIO_SECONDS) {
        const bytes = new Uint8Array(clip.buffer, clip.byteOffset, clip.byteLength);
        sendJson({
          type: "transcribe_file_start",
          sampleRate: cfg.sampleRate,
          byteLength: bytes.byteLength,
        });
        await sendBytesReliably(bytes, epoch);
        sendJson({ type: "transcribe_file_end" });
        return;
      }
      // Long uploads stream through the realtime STT path, padded with a second
      // of silence (zeros) so the provider's endpointing commits the final turn.
      const padded = new Int16Array(clip.length + cfg.sampleRate);
      padded.set(clip);
      await sendBytesReliably(new Uint8Array(padded.buffer), epoch);
    } finally {
      uploadInFlight = false;
    }
  }

  return {
    sendAudioFile,
    inFlight: () => uploadInFlight,
    discard: () => {
      uploadEpoch++;
    },
  };
}
