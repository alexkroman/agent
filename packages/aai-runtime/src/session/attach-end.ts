// Copyright 2026 the AAI authors. MIT license.
/**
 * The two ways a session's far end is closed by the APP rather than by a
 * failure or a hang-up: `sessionContext` refused the session, or a tool called
 * `endSession(ctx)`.
 *
 * Split out of `attach.ts` at the 500-line cap, on the seam these two
 * share: both are a close the lifecycle does not originate, and each has to be
 * told apart from the closes it does — a refusal from a failed start (no
 * `error.reported`, a 1008 rather than a 1011), and a tool's end from a drop
 * (it waits for the goodbye to be heard). WHEN each runs is still
 * `attach.ts`'s; this is HOW.
 */

import type { ClientSink } from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "../runtime-config.ts";
import type { AttachSessionOptions } from "./attach.ts";

/**
 * `session.start()` rejected because the app's `sessionContext` answered
 * `refuse` — thrown by `../runtime-session-stream.ts` before the transport starts,
 * and told apart from a failed start in `attach.ts`, where the close is
 * decided.
 *
 * @internal
 */
export class SessionRefusedError extends Error {
  override readonly name = "SessionRefusedError";
  /** The app's reason, as `context.ts` cleaned it. */
  readonly reason: string;
  constructor(reason: string) {
    super(`session refused: ${reason}`);
    this.reason = reason;
  }
}

/** What both closes need from the attached connection. */
type CloseDeps = {
  client: ClientSink;
  options: Pick<AttachSessionOptions, "closeAfterRefusal" | "closeOnEndSession">;
  log: Logger;
};

/**
 * Close a refused session's far end. No `error.reported` first: nothing
 * failed, and the frame's `fatal` would read to a client as "retry".
 *
 * @internal
 */
export function closeRefused(reason: string, deps: CloseDeps): void {
  try {
    if (deps.options.closeAfterRefusal) deps.options.closeAfterRefusal(reason);
    else deps.client.close?.(reason);
  } catch (err) {
    deps.log.debug("ws: close after refusal failed", { error: errorMessage(err) });
  }
}

/**
 * What `endSession(ctx)` reaches for one session: close the far end, which is a
 * normal stop — the adapter's close event detaches, the session stops, its log
 * is flushed and `onSessionEnd` fires. Once only: a tool that asks twice, or two
 * tools in one turn, end it once.
 *
 * @internal
 */
export function endOnRequest(
  deps: CloseDeps & { ctx: Record<string, string>; sid: string },
): (request: { afterReply: boolean }) => void {
  let requested = false;
  return (request) => {
    if (requested) return;
    requested = true;
    deps.log.info("Session ending at a tool's request", {
      ...deps.ctx,
      sid: deps.sid,
      afterReply: request.afterReply,
    });
    try {
      if (deps.options.closeOnEndSession) deps.options.closeOnEndSession(request);
      else deps.client.close?.("session ended by the agent");
    } catch (err) {
      deps.log.debug("ws: close on endSession failed", { error: errorMessage(err) });
    }
  };
}
