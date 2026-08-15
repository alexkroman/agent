// Copyright 2026 the AAI authors. MIT license.
/**
 * How a transport's callbacks reach a session — and the one of them that is
 * wired three different ways.
 *
 * Split out of `runtime.ts` at the 500-line cap. Most of this is a flat forward
 * to the `SessionCore`; what earns it a module is `onToolCall`, where the right
 * wiring depends on the transport and on relay mode, and where two of the three
 * wrong answers are silent.
 *
 * ## `onToolCall`, by transport and mode
 *
 * - **S2S** — route through the session, which executes the tool and emits its
 *   completion itself. The provider is waiting for a `tool.result`, so nobody
 *   else can own this.
 * - **Pipeline, in-process** — the tool already ran, inside `streamText`. So this
 *   is observability only: EMIT the event and go no further. Routing it through
 *   the session would execute the tool a second time and then hang the turn,
 *   because the session would be holding a pending result the provider never
 *   asked for.
 * - **Pipeline, relay** — do nothing at all. The relay executor emitted
 *   `tool.called` when it asked the client to run the tool; a second emit is a
 *   duplicate frame the CLIENT runs twice, which corrupts write state and doubles
 *   read latency.
 *
 * `onToolCallDone` follows the same rule from the other end: pipeline in-process
 * emits it so a UI can flip a tool row from pending to done, S2S never sets it
 * (the session emits its own), and relay suppresses it because the client already
 * has the result it computed.
 */

import type { SessionCore } from "./session-core.ts";
import type { SessionEmitter } from "./session-emitter.ts";
import type { TransportCallbacks } from "./transports/types.ts";

/** What the wiring needs to know about the session being built. */
export type SessionCallbackDeps = {
  /**
   * The session, resolved LATE. Callbacks are constructed before the
   * `SessionCore` exists — the transport is built from them and the session is
   * built from the transport — so this throws rather than returning undefined:
   * a callback firing before the session exists is a wiring bug, not a state.
   */
  bindCore: () => SessionCore;
  /** This session's emitter, for the events no session method owns. */
  emitter: SessionEmitter;
  /** True when the pipeline transport runs this session (tools run in `streamText`). */
  isPipeline: boolean;
  /** True when tool execution is relayed to the client (host mode). */
  isRelay: boolean;
};

/**
 * Build one session's transport callbacks.
 *
 * @internal
 */
export function buildSessionCallbacks(deps: SessionCallbackDeps): TransportCallbacks {
  const { bindCore, emitter, isPipeline, isRelay } = deps;

  let onToolCall: TransportCallbacks["onToolCall"];
  if (!isPipeline) {
    onToolCall = (id, name, args) => bindCore().onToolCall(id, name, args);
  } else if (isRelay) {
    onToolCall = () => undefined;
  } else {
    onToolCall = (id, name, args) =>
      emitter.emit({ type: "tool.called", toolCallId: id, toolName: name, args });
  }

  return {
    onReplyStarted: (replyId) => bindCore().onReplyStarted(replyId),
    onReplyDone: () => bindCore().onReplyDone(),
    onCancelled: () => bindCore().onCancelled(),
    onAudioChunk: (bytes) => bindCore().onAudioChunk(bytes),
    onAudioDone: () => bindCore().onAudioDone(),
    onUserTranscript: (text) => bindCore().onUserTranscript(text),
    onUserTranscriptPartial: (text) => bindCore().onUserTranscriptPartial(text),
    onAgentTranscript: (text, interrupted) => bindCore().onAgentTranscript(text, interrupted),
    onAgentTranscriptPartial: (text) => bindCore().onAgentTranscriptPartial(text),
    onToolCall,
    ...(isPipeline && !isRelay
      ? {
          onToolCallDone: (id: string, result: string) =>
            emitter.emit({ type: "tool.completed", toolCallId: id, result }),
        }
      : {}),
    onError: (code, message, errOpts) => bindCore().onError(code, message, errOpts),
    onSpeechStarted: () => bindCore().onSpeechStarted(),
    onSpeechStopped: () => bindCore().onSpeechStopped(),
  };
}
