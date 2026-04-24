// Copyright 2026 the AAI authors. MIT license.
// Transport strategy — per-session provider wiring (S2S, pipeline, etc.).

import type { ErrorCode } from "../../sdk/protocol.ts";
import type { Message } from "../../sdk/types.ts";

/**
 * Typed callbacks into the SessionCore. One per event the transport produces.
 * Constructed at transport-creation time; no emitter.on-style indirection.
 */
export type TransportCallbacks = {
  onReplyStarted(replyId: string): void;
  onReplyDone(): void;
  onCancelled(): void;
  onAudioChunk(bytes: Uint8Array): void;
  onAudioDone(): void;
  onUserTranscript(text: string): void;
  onAgentTranscript(text: string, interrupted: boolean): void;
  onToolCall(callId: string, name: string, args: Record<string, unknown>): void;
  onError(code: ErrorCode, message: string): void;
  onSpeechStarted(): void;
  onSpeechStopped(): void;
  onSessionReady?(providerSessionId: string): void;
};

/** Minimal config a transport may receive at construction time. */
export type TransportSessionConfig = {
  systemPrompt: string;
  greeting?: string;
  tools?: unknown[];
  history?: Message[];
};

/**
 * Transport abstraction — one implementation per provider strategy
 * (see `s2s-transport.ts`, `pipeline-transport.ts`).
 */
export interface Transport {
  /** Open any underlying connections and send initial session config. */
  start(): Promise<void>;
  /** Tear down, flush, close. Idempotent. */
  stop(): Promise<void>;
  /** Forward user audio to the provider. */
  sendUserAudio(bytes: Uint8Array): void;
  /** Forward a tool result back to the provider's reply stream. */
  sendToolResult(callId: string, result: string): void;
  /** Cancel the currently in-flight reply (barge-in / client cancel). */
  cancelReply(): void;
  /** Re-send session config (S2S only; pipeline is a no-op). */
  updateSession?(config: TransportSessionConfig): void;
}
