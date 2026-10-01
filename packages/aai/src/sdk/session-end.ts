// Copyright 2026 the AAI authors. MIT license.
/**
 * Ending a session from a tool — a phone agent's `end_call`.
 *
 * Before this a session ended only when the FAR end left (the caller hung up,
 * the tab closed) or the idle timeout fired. A voice agent on a phone line has
 * to be able to hang up itself: once it has said "thanks, goodbye" the call is
 * over, and a caller left on an open line hears dead air until the idle
 * timeout, billed by the minute.
 *
 * ## A function of the context, not a field on it
 *
 * `guard-invariants` rule 24 asks that a `ToolContext` field be per-CALL and
 * unreachable any other way. This is per-SESSION, and it is reachable from
 * `ctx.sessionId` — the shape `sessionClientId(ctx)` and `sessionCall(ctx)`
 * already have. So it is `endSession(ctx)`, and a test double gets it by
 * registering an ender for its session id (`createToolContext` does).
 *
 * ## What "end" means
 *
 * A NORMAL stop, the same one a hang-up produces: the runtime closes the
 * session's connection with a normal close, the session stops, its events are
 * flushed and `onSessionEnd` fires. For a `WS /phone` session closing the
 * connection closes the carrier's media stream, and with `<Connect><Stream>`
 * that is the call's end: Twilio runs the TwiML after `<Connect>` once the
 * server closes the socket, and with none left it hangs up.
 *
 * By default it waits for the current reply to finish SPEAKING — the reply the
 * tool call belongs to, which is the one that says goodbye — so the caller
 * hears the last line before the line goes dead.
 *
 * ## A global slot, owned by claim
 *
 * The runtime registers the ender and a tool in the agent bundle calls it, two
 * copies of this module, so the registry hangs off `globalThis` under a
 * `Symbol.for` key. An {@link OwnedMap}, because a resumed session registers
 * a NEW ender under the SAME id while the old connection's teardown is still
 * settling — a bare delete there would unregister the live one.
 *
 * @module
 */

import { globalSlot } from "./_boundary.ts";
import { createOwnedMap, type OwnedMap } from "./owned-map.ts";
import type { ToolContext } from "./tool-context.ts";

/**
 * Options for {@link endSession}.
 *
 * @public
 */
export type EndSessionOptions = {
  /**
   * Let the current reply finish SPEAKING before the session ends. Default
   * `true`: the reply the calling tool belongs to is the one with the goodbye in
   * it, and ending before it is heard hangs up mid-sentence. `false` ends it now.
   *
   * Bounded either way — a reply that never finishes does not hold the
   * connection open (`aai-runtime`'s `END_SESSION_REPLY_TIMEOUT_MS`).
   */
  afterReply?: boolean | undefined;
};

/** What the runtime registers for a session — see {@link claimSessionEnder}. */
export type SessionEnder = (options: { afterReply: boolean }) => void;

const SESSION_ENDERS_SLOT = globalSlot<OwnedMap<string, SessionEnder>>("sessionEnders");

function enders(): OwnedMap<string, SessionEnder> {
  let map = SESSION_ENDERS_SLOT.get();
  if (map === undefined) {
    map = createOwnedMap();
    SESSION_ENDERS_SLOT.set(map);
  }
  return map;
}

/**
 * Register how `sessionId` is ended; returns the release for THIS claim, a
 * no-op once a resumed connection has claimed the id again.
 *
 * @internal — the runtime's half (`session-attach.ts`), and `createToolContext`'s.
 */
export function claimSessionEnder(sessionId: string, ender: SessionEnder): () => boolean {
  return enders().claim(sessionId, ender);
}

/**
 * End this session — a phone agent's `end_call`.
 *
 * By default the current reply finishes speaking first, so return what the
 * agent should say last and the caller hears it:
 *
 * ```ts
 * import { endSession, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Hang up. Call it once the caller has said goodbye.",
 *   inputSchema: z.object({}),
 *   execute(_args, ctx) {
 *     endSession(ctx);
 *     return { ended: true, say: "Say a short goodbye." };
 *   },
 * });
 * ```
 *
 * The end is a normal stop: `onSessionEnd` fires and the session's events are
 * flushed. A phone session's carrier stream is closed, which with
 * `<Connect><Stream>` hangs the call up; a browser or device socket is closed
 * with a normal (1000) close. A second call is a no-op.
 *
 * @returns `true` when the session was live and will end; `false` when there is
 * nothing to end (it already ended, or this context belongs to no connected
 * session).
 */
export function endSession(
  ctx: Pick<ToolContext, "sessionId">,
  options: EndSessionOptions = {},
): boolean {
  const ender = enders().get(ctx.sessionId);
  if (ender === undefined) return false;
  ender({ afterReply: options.afterReply ?? true });
  return true;
}
