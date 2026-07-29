// Copyright 2026 the AAI authors. MIT license.
// One-shot uploaded-clip transcription for the pipeline transport
// (`Transport.transcribeFile`). Split out of `pipeline-transport.ts`; the
// transport injects its turn machinery and owns the terminated/audioReady
// gating around `transcribeFile`.

import { FILE_UPLOAD_CHUNK_BYTES } from "../../sdk/constants.ts";
import type { SttOpener } from "../../sdk/providers.ts";
import { errorMessage } from "../../sdk/utils.ts";
import { bytesToPcm16, withTrailingSilence } from "../_pcm.ts";
import type { TransportCallbacks } from "./types.ts";

/** One-shot upload transcription, owned by one pipeline transport. */
export type FileTranscriber = {
  /** Transcribe an uploaded clip and run it as a user turn (see below). */
  transcribeFile(pcm: Uint8Array, sampleRate: number): void;
  /** Discard any in-flight transcription (reset / client cancel): its
   *  transcript must not commit into the new conversation. */
  discard(): void;
};

export function createFileTranscriber(deps: {
  /** The STT provider's batch capability; absent → realtime replay fallback. */
  transcribeClip: SttOpener["transcribeClip"] | undefined;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch | undefined;
  signal: AbortSignal;
  isTerminated: () => boolean;
  /** Forward PCM16 into the realtime STT socket (the fallback path). */
  sendRealtimeAudio: (pcm16: Int16Array) => void;
  /** The transport's turn serializer + turn runner. */
  chainTurn: (run: () => Promise<void>) => void;
  runTurn: (text: string) => Promise<void>;
  callbacks: Pick<TransportCallbacks, "onError" | "onUserTranscript">;
  onTurnCrash: (err: unknown) => void;
}): FileTranscriber {
  // Bumped by discard() so an in-flight one-shot transcription started
  // before a reset cannot commit its transcript into the new conversation.
  let epoch = 0;

  /**
   * One-shot transcription of an uploaded clip via the STT provider's batch
   * capability: transcribe in a single request, then run the committed text
   * as a normal user turn. A failed transcription is a turn-level error
   * (`fatal: false` on the wire), not a session teardown.
   */
  async function transcribeFileTurn(
    transcribeClip: NonNullable<SttOpener["transcribeClip"]>,
    pcm: Uint8Array,
    sampleRate: number,
  ): Promise<void> {
    const startEpoch = epoch;
    let text: string;
    try {
      text = (
        await transcribeClip(pcm, sampleRate, {
          apiKey: deps.apiKey,
          fetch: deps.fetchImpl,
          signal: deps.signal,
        })
      ).trim();
    } catch (err) {
      if (!deps.isTerminated() && startEpoch === epoch) {
        deps.callbacks.onError("stt", errorMessage(err), { fatal: false });
      }
      return;
    }
    // The upload was discarded (reset / client cancel) while transcribing —
    // its transcript must not surface in the new conversation.
    if (!text || deps.isTerminated() || startEpoch !== epoch) return;
    deps.callbacks.onUserTranscript(text);
    await deps.runTurn(text).catch(deps.onTurnCrash);
  }

  return {
    transcribeFile(pcm: Uint8Array, sampleRate: number): void {
      const { transcribeClip } = deps;
      if (!transcribeClip) {
        // No one-shot backend on this provider: replay through its realtime
        // socket, padded with silence so endpointing commits the final turn
        // (the client skips padding on the one-shot upload path).
        const padded = withTrailingSilence(pcm, sampleRate);
        for (let i = 0; i < padded.byteLength; i += FILE_UPLOAD_CHUNK_BYTES) {
          deps.sendRealtimeAudio(bytesToPcm16(padded.subarray(i, i + FILE_UPLOAD_CHUNK_BYTES)));
        }
        return;
      }
      deps.chainTurn(() => transcribeFileTurn(transcribeClip, pcm, sampleRate));
    },
    discard(): void {
      epoch++;
    },
  };
}
