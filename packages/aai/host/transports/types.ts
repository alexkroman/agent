// Copyright 2026 the AAI authors. MIT license.
// Transport strategy — per-session provider wiring (S2S, pipeline, etc.).

import type { SessionErrorCode } from "../../sdk/protocol.ts";
import type { Message } from "../../sdk/types.ts";

/**
 * Typed callbacks into the SessionCore. One per event the transport produces.
 * Constructed at transport-creation time; no emitter.on-style indirection.
 *
 * @internal
 */
export type TransportCallbacks = {
  onReplyStarted(replyId: string): void;
  onReplyDone(): void;
  onCancelled(): void;
  onAudioChunk(bytes: Uint8Array): void;
  onAudioDone(): void;
  onUserTranscript(text: string): void;
  /**
   * Interim user transcript while speech is still in progress. Pipeline mode
   * forwards STT partials so the client can render live captions; S2S
   * transports never call it (their providers only surface committed turns).
   */
  onUserTranscriptPartial?(text: string): void;
  onAgentTranscript(text: string, interrupted: boolean): void;
  /**
   * The reply's transcript *so far*, cumulative — called each time more of it
   * becomes audible, so a client's captions keep pace with the speech instead
   * of landing in one lump when the reply ends.
   *
   * Pipeline mode calls this as text reaches TTS. It matters most for a reply
   * that spends 10+ seconds in a tool chain: the hold phrase and the dead-air
   * cover are spoken minutes before `onAgentTranscript` fires, and a client
   * pairing text with audio has already played that audio by then. S2S
   * transports leave it unset — their providers surface a reply's transcript
   * once, when it is complete.
   */
  onAgentTranscriptPartial?(text: string): void;
  onToolCall(callId: string, name: string, args: Record<string, unknown>): void;
  /**
   * Tool execution finished. Pipeline mode invokes this from the
   * `tool-result` stream part so the client UI can mark the call done.
   * S2S transports leave this unset — SessionCore.onToolCall emits the
   * `tool_call_done` event itself after dispatching the tool.
   */
  onToolCallDone?(callId: string, result: string): void;
  onError(code: SessionErrorCode, message: string, opts?: { fatal?: boolean }): void;
  onSpeechStarted(): void;
  onSpeechStopped(): void;
  onSessionReady?(providerSessionId: string): void;
};

/** Per-error options a transport may attach — the shape `onError` takes. */
export type EmitErrorOpts = { fatal?: boolean };

/**
 * A transport's own error reporter, threaded into its internals.
 *
 * **Omitting `fatal` means the session is OVER**, because `onError` defaults to
 * fatal and aai-ui answers a fatal frame by releasing the microphone and ending
 * the call. A failing TURN is not a failing session: pass `{ fatal: false }`
 * unless the caller is on a path that really terminates.
 *
 * @internal
 */
export type EmitError = (code: SessionErrorCode, message: string, opts?: EmitErrorOpts) => void;

/**
 * Minimal config a transport may receive at construction time.
 * @internal
 */
export type TransportSessionConfig = {
  systemPrompt: string;
  greeting?: string;
  history?: Message[];
};

/**
 * Transport abstraction — one implementation per provider strategy
 * (see `s2s-transport.ts`, `pipeline-transport.ts`).
 *
 * @internal
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
