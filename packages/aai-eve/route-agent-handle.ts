// Copyright 2026 the AAI authors. MIT license.
/**
 * Maps eve's channel-route session API onto the `EveAgentHandle` the aai
 * eve turn runner consumes.
 *
 * A channel route doesn't get raw `run`/`deliver` — it gets `send()` (which
 * starts a session or resumes the one owning the continuation token) and
 * `getSession()` (a handle carrying `cancel` + `getEventStream`). The turn
 * runner's run/deliver distinction therefore collapses onto `send`, which
 * also means its deliver-failed-fall-back-to-run path never fires here —
 * `send` re-starts an expired session by itself.
 *
 * Structural on the eve side (mirrors `RouteHandlerArgs`/`Session` from
 * eve 0.28) so this module — like the turn runner — has no hard eve import
 * and stays unit-testable without an eve runtime.
 */

import type { EveAgentHandle, EveStreamEvent } from "@alexkroman1/aai/runtime";

/** Structural mirror of eve's route-facing `Session` result. */
export interface VoiceSessionLike {
  readonly id: string;
  readonly continuationToken: string;
  cancel(options?: { turnId?: string }): Promise<unknown>;
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<EveStreamEvent>>;
}

/** The subset of eve's `RouteHandlerArgs` the voice channel uses. */
export interface VoiceRouteArgsLike {
  send(
    payload: { message: string },
    options: {
      auth: null;
      continuationToken: string;
      mode?: "conversation" | "task";
    },
  ): Promise<VoiceSessionLike>;
  getSession(sessionId: string): VoiceSessionLike;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Build the {@link EveAgentHandle} for one voice connection from the route's
 * args. Every turn goes through `send` in conversation mode; cancellation
 * and event reads resolve through `getSession`.
 */
export function routeAgentHandle(args: VoiceRouteArgsLike): EveAgentHandle {
  async function send(message: string, continuationToken: string): Promise<{ sessionId: string }> {
    const session = await args.send(
      { message },
      { auth: null, continuationToken, mode: "conversation" },
    );
    return { sessionId: session.id };
  }

  return {
    run(input: Record<string, unknown>) {
      const payload = (input.input ?? {}) as Record<string, unknown>;
      return send(str(payload.message), str(input.continuationToken));
    },
    deliver(input: { continuationToken: string; payload: Record<string, unknown> }) {
      return send(str(input.payload.message), input.continuationToken);
    },
    async cancelTurn(input: { sessionId: string; turnId?: string }) {
      return args
        .getSession(input.sessionId)
        .cancel(input.turnId === undefined ? {} : { turnId: input.turnId });
    },
    getEventStream(sessionId: string, options?: { startIndex?: number }) {
      return args.getSession(sessionId).getEventStream(options);
    },
  };
}
