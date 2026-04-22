// Copyright 2025 the AAI authors. MIT license.
/** TTS provider interface — normalized seam over any streaming TTS SDK. */

import type { Unsubscribe } from "./stt.ts";

export interface TtsError extends Error {
  readonly code: "tts_connect_failed" | "tts_auth_failed" | "tts_stream_error";
}

export type TtsEvents = {
  /** One PCM16 audio chunk. Orchestrator forwards to the client. */
  audio: (pcm: Int16Array) => void;
  /** Synthesis drained after flush() or cancel(). Emitted exactly once per turn. */
  done: () => void;
  /** Terminal error. The session is expected to end after this fires. */
  error: (err: TtsError) => void;
};

export interface TtsSession {
  /** Push text deltas from the LLM. Provider may synthesize as chunks arrive. */
  sendText(text: string): void;
  /** Signal "no more text this turn". Emits `done` when fully synthesized. */
  flush(): void;
  /** Interrupt immediately (barge-in). Emits `done` synchronously. */
  cancel(): void;
  on<E extends keyof TtsEvents>(event: E, fn: TtsEvents[E]): Unsubscribe;
  close(): Promise<void>;
}

export interface TtsOpenOptions {
  sampleRate: number;
  apiKey: string;
  signal: AbortSignal;
}

export interface TtsProvider {
  readonly name: string;
  open(opts: TtsOpenOptions): Promise<TtsSession>;
}
