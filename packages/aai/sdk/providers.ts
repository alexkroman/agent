// Copyright 2025 the AAI authors. MIT license.
/**
 * Pluggable provider interfaces — normalized seams over streaming STT / TTS
 * SDKs, plus the LLM provider type.
 *
 * These are zero-runtime **type** declarations with no Node.js dependencies,
 * so they live in `sdk/` alongside the `Manifest` type that references them.
 * Concrete adapters (e.g. AssemblyAI STT, Cartesia TTS) live under
 * `host/providers/` because they depend on Node-only SDKs.
 */

import type { LanguageModel } from "ai";

/** Unsubscribe callback returned by `.on()` event subscriptions. */
export type Unsubscribe = () => void;

// -------- STT --------

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

// -------- TTS --------

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

// -------- LLM --------

/** LLM provider — Vercel AI SDK's `LanguageModel`; no wrapping. */
export type LlmProvider = LanguageModel;
