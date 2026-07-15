// Copyright 2026 the AAI authors. MIT license.
// Transport strategy — per-session provider wiring (S2S, pipeline, etc.).

import type { SessionErrorCode } from "../../sdk/protocol.ts";
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
  /**
   * Tool execution finished. Pipeline mode invokes this from the
   * `tool-result` stream part so the client UI can mark the call done.
   * S2S transports leave this unset — SessionCore.onToolCall emits the
   * `tool_call_done` event itself after dispatching the tool.
   */
  onToolCallDone?(callId: string, result: string): void;
  onError(code: SessionErrorCode, message: string): void;
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
  /**
   * Seed prior conversation into the transport's own history on reconnect.
   * Pipeline mode owns the LLM message list, so client-resent history must
   * reach it here or a resumed agent has no memory. S2S transports keep
   * context service-side (via session.resume) and omit this.
   */
  seedHistory?(messages: readonly Message[]): void;
  /**
   * Clear the transport's conversation state (client `reset`). Pipeline mode
   * clears its message list; S2S has no client-side history to drop.
   */
  reset?(): void;
}
