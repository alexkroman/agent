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

/**
 * Config passed to a transport at construction time and, for transports that
 * support it, via {@link Transport.updateSession} for live reconfiguration.
 *
 * Note: `history` is consumed only at construction time by pipeline transports;
 * it is ignored by {@link Transport.updateSession}.
 *
 * Note: `tools` is typed `unknown[]` because each transport casts it to its
 * own provider-specific tool-schema type (e.g. `S2sToolSchema[]`).
 */
export type TransportSessionConfig = {
  systemPrompt: string;
  greeting?: string;
  tools?: unknown[];
  /** Initial conversation history. Ignored by {@link Transport.updateSession}. */
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
  /**
   * Re-apply session config to a live transport (e.g. after a system-prompt
   * change). Not all transports support live reconfiguration; implementations
   * that do not may omit this method or treat it as a no-op.
   */
  updateSession?(config: TransportSessionConfig): void;
}
