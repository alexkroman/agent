// Copyright 2026 the AAI authors. MIT license.
/**
 * Sync-turn wire format — the HTTP request/response counterpart of the
 * WebSocket protocol in `protocol.ts`.
 *
 * A sync turn is one complete conversational exchange over a single
 * `POST /sync` request: the client sends either committed text or one full
 * utterance of audio (endpointed client-side, e.g. by a WebRTC/VAD capture
 * pipeline), and the server answers with the transcript, the assistant
 * reply, and — when the TTS provider has a one-shot synthesis capability —
 * the spoken reply as PCM16.
 *
 * No connection state exists between turns: the client carries the
 * conversation history and sends it with every request. Node-free by
 * design (`sdk/`), so the same schemas validate in the browser client.
 */

import { z } from "zod";
import {
  MAX_AUDIO_SAMPLE_RATE,
  MAX_SYNC_AUDIO_BYTES,
  MAX_SYNC_HISTORY_MESSAGES,
  MAX_TRANSCRIPT_CHARS,
} from "./constants.ts";

/**
 * One prior conversation turn, as the client replays it. Only committed
 * user/assistant text crosses the wire — tool traffic stays server-side
 * within the turn that produced it.
 */
export const SyncHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(MAX_TRANSCRIPT_CHARS),
});

/** One prior conversation turn carried in a sync-turn request. */
export type SyncHistoryMessage = z.infer<typeof SyncHistoryMessageSchema>;

/**
 * Body of `POST /sync`. Exactly one of `text` / `audio` must be set;
 * `audio` is base64 mono PCM16LE and requires `sampleRate`. The base64
 * length cap corresponds to {@link MAX_SYNC_AUDIO_BYTES} of decoded audio
 * (base64 expands 3 bytes into 4 characters).
 */
export const SyncTurnRequestSchema = z
  .object({
    /** Committed user text (skips STT). */
    text: z.string().min(1).max(MAX_TRANSCRIPT_CHARS).optional(),
    /** One utterance of base64 mono PCM16LE audio. */
    audio: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_SYNC_AUDIO_BYTES / 3) * 4, "audio exceeds the sync transcription cap")
      .optional(),
    /** Sample rate of `audio` in Hz. Required with `audio`. */
    sampleRate: z.number().int().positive().max(MAX_AUDIO_SAMPLE_RATE).optional(),
    /** Prior turns, oldest first. The server trims to its history window. */
    history: z.array(SyncHistoryMessageSchema).max(MAX_SYNC_HISTORY_MESSAGES).default([]),
  })
  .superRefine((req, ctx) => {
    if ((req.text === undefined) === (req.audio === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of text or audio must be set",
      });
    }
    if (req.audio !== undefined && req.sampleRate === undefined) {
      ctx.addIssue({ code: "custom", message: "audio requires sampleRate" });
    }
  });

/** Parsed body of `POST /sync`. */
export type SyncTurnRequest = z.infer<typeof SyncTurnRequestSchema>;

/**
 * Response of `POST /sync`. `audio` (base64 mono PCM16LE at `sampleRate`)
 * is present only when the agent's TTS provider supports one-shot
 * synthesis and it succeeded; a synthesis failure surfaces in `ttsError`
 * rather than discarding the text reply that already exists.
 */
export const SyncTurnResponseSchema = z.object({
  /** What the user said (echoes `text`, or the STT transcript of `audio`). */
  transcript: z.string(),
  /** The assistant's text reply. */
  reply: z.string(),
  /** Base64 mono PCM16LE of the spoken reply, when synthesized. */
  audio: z.string().optional(),
  /** Sample rate of `audio` in Hz. Present exactly when `audio` is. */
  sampleRate: z.number().int().positive().optional(),
  /** Set when TTS synthesis failed; the text `reply` is still complete. */
  ttsError: z.string().optional(),
});

/** Parsed response of `POST /sync`. */
export type SyncTurnResponse = z.infer<typeof SyncTurnResponseSchema>;
