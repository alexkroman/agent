// Copyright 2026 the AAI authors. MIT license.
/**
 * How a transport's reports reach a session — and the one of them that is routed
 * three different ways.
 *
 * This used to be a flat forward of thirteen identically-named callbacks, which is
 * what made it a module at all: `runtime.ts` was at the 500-line cap and the
 * forwarding table had to go somewhere. The table is gone — a transport reports a
 * `TransportEventBody` and the session takes one (see `transports/types.ts`) — so
 * what is left is the part that was never plumbing.
 *
 * ## `tool.called`, by transport and mode
 *
 * - **S2S** — route through the session, which executes the tool and emits its
 *   own `tool.called`. The provider is waiting for a `tool.result`, so nobody
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
 * `tool.completed` follows the same rule from the other end: pipeline in-process
 * publishes it so a UI can flip a tool row from pending to done, S2S never reports
 * one (the session emits its own from `session-tool-steps.ts`), and relay
 * suppresses it because the client already has the result it computed.
 */

import type { ServerSession } from "./session-core.ts";
import type { SessionEmitter } from "./session-emitter.ts";
import type { TransportCallbacks, TransportEventBody } from "./transports/types.ts";

/** What the wiring needs to know about the session being built. */
export type SessionCallbackDeps = {
  /**
   * The session, resolved LATE. Callbacks are constructed before the
   * `ServerSession` exists — the transport is built from them and the session is
   * built from the transport — so this throws rather than returning undefined:
   * a callback firing before the session exists is a wiring bug, not a state.
   */
  bindCore: () => ServerSession;
  /** This session's emitter, for the reports no session method owns. */
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

  function report(event: TransportEventBody): void {
    if (event.type === "tool.called" && isPipeline) {
      // Observability only in-process; nothing at all under relay.
      if (!isRelay) emitter.emit(event);
      return;
    }
    // Only pipeline mode ever reports `tool.completed` — S2S's session emits its
    // own — so the relay suppression is the whole of this branch.
    if (event.type === "tool.completed" && isRelay) return;
    bindCore().report(event);
  }

  return {
    report,
    onAudioChunk: (bytes) => bindCore().onAudioChunk(bytes),
    onReplyStarted: (replyId) => bindCore().onReplyStarted(replyId),
  };
}
