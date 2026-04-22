// Copyright 2025 the AAI authors. MIT license.
/** STT provider interface — normalized seam over any streaming STT SDK. */

export type Unsubscribe = () => void;

export interface SttError extends Error {
  readonly code: "stt_connect_failed" | "stt_auth_failed" | "stt_stream_error";
}

export type SttEvents = {
  /** Interim transcript; drives barge-in detection. */
  partial: (text: string) => void;
  /** End-of-turn final transcript; cue to run the LLM. */
  final: (text: string) => void;
  /** Terminal error. The session is expected to end after this fires. */
  error: (err: SttError) => void;
};

export interface SttSession {
  sendAudio(pcm: Int16Array): void;
  on<E extends keyof SttEvents>(event: E, fn: SttEvents[E]): Unsubscribe;
  close(): Promise<void>;
}

export interface SttOpenOptions {
  sampleRate: number;
  apiKey: string;
  sttPrompt?: string | undefined;
  signal: AbortSignal;
}

export interface SttProvider {
  readonly name: string;
  open(opts: SttOpenOptions): Promise<SttSession>;
}
