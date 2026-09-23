// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:session` epoch 2.
 *
 * ## What moved, and why epoch 2 survives it
 *
 * `TransportEventBody` and `TransportEventType` each gained one member,
 * `"metrics.collected"` — the per-reply frame the pipeline transport reports
 * when a reply settles. The same shape as epoch 2's own move
 * (`"user-turn.exceeded"`, see `v1.ts`): a union that GREW, so every event an
 * epoch-2 transport reported is still a member and `report()` below compiles
 * unchanged. A reader switching EXHAUSTIVELY over `TransportEventType` would
 * gain an unhandled arm; this file writes a `default`, as an epoch-2 host
 * that wanted to keep compiling would have.
 *
 * `v1.ts` names every export of this capability and epoch 2 added none, so
 * this carries only the epoch-2 shape the grown union lands in.
 *
 * Relative specifiers, as every frozen example.
 *
 * @module
 */

import type {
  ServerSession,
  TransportEventBody,
  TransportEventType,
} from "../../../runtime-barrel.ts";

/** Epoch 2's addition, reported the way a custom transport reports it. */
export function reportTurnCut(session: ServerSession, words: number, durationMs: number): void {
  const event: TransportEventBody = {
    type: "user-turn.exceeded",
    limit: "words",
    words,
    durationMs,
  };
  session.report(event);
}

/** A per-type recorder with a `default` arm — unaffected by a member added. */
export function label(type: TransportEventType): string {
  switch (type) {
    case "user-transcript.committed":
      return "caller";
    case "user-turn.exceeded":
      return "cut";
    case "reply.completed":
      return "agent";
    default:
      return "other";
  }
}
