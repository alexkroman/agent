// Copyright 2026 the AAI authors. MIT license.
/**
 * Turning a socket away with a REASON.
 *
 * Split out of `server.ts` at the 500-line cap, and it is a real seam rather than
 * a slice: nothing here knows what a session is. Every path is a socket this
 * server has accepted and will not serve — a `createHostServer` whose
 * `/websocket` has no agent behind it, a `page: "static"` agent that has no voice
 * surface, and host mode being off.
 *
 * The rule they share is the one worth keeping: a refusal must SAY something.
 * Closing a bare socket leaves the client reconnecting against a server that will
 * never answer, with nothing in the frame log explaining why.
 */

import { consoleLogger, type Logger } from "./runtime-config.ts";
import type { SessionRuntime } from "./server.ts";
import { stampSessionEvent } from "./session-event-stream.ts";
import { safeSend } from "./ws-handler.ts";

/**
 * A {@link SessionRuntime} that turns every session away with a protocol error
 * and closes, instead of accepting a socket it cannot answer.
 *
 * For a server whose `/websocket` has no agent behind it — `createHostServer`,
 * which serves only `?host=1` sessions. The guest harness hand-rolls the same
 * shape for its drain refusal; this is here so the third one does not get
 * written by hand too.
 *
 * A refusal must SAY something: closing a bare socket leaves the client
 * reconnecting against a server that will never answer, with nothing in the
 * frame log explaining why.
 */
export function rejectingRuntime(message: string, logger: Logger = consoleLogger): SessionRuntime {
  return {
    startSession: (ws) => declineSocket(ws, message, logger),
    shutdown: () => Promise.resolve(),
  };
}

/**
 * Tell an accepted socket why it is not being served, then close it.
 *
 * One spelling for the three refusals (`rejectingRuntime`, a static agent's
 * `/websocket`, host mode off), which had three copies of the same
 * stamp-serialize-send-close. The frame is STAMPED here rather than emitted:
 * these paths have no session, so there is nothing to record it in.
 */
export function declineSocket(
  ws: Parameters<typeof safeSend>[0] & { close?: (code?: number) => void },
  message: string,
  logger: Logger,
): void {
  safeSend(
    ws,
    JSON.stringify(
      stampSessionEvent({ type: "error.reported", code: "protocol", message, fatal: true }),
    ),
    logger,
  );
  ws.close?.(1008);
}
