// Copyright 2026 the AAI authors. MIT license.
/**
 * `Runtime.connect` — a session over a caller-owned {@link ClientSink}.
 *
 * The public adapter over `session-attach.ts`, beside the WebSocket one in
 * `ws-handler.ts`. It adds two things a socket adapter gets elsewhere: the
 * real-time pacing wrapper (`ws-client-sink.ts` applies it for a socket), and a
 * self-detach when the RUNTIME closes the sink, since a caller-owned sink has
 * no close event of its own to report back with.
 */

import type { ClientSink } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { createPacedClientSink } from "./paced-client-sink.ts";
import type { SessionConnection, SessionConnectOptions } from "./runtime-types.ts";
import {
  type AttachedSession,
  type AttachSessionOptions,
  attachSession,
} from "./session-attach.ts";
import type { ServerSession } from "./session-core.ts";

/** What the runtime supplies a connection. */
export type ConnectDeps = Pick<AttachSessionOptions, "sessions" | "readyConfig" | "logger"> & {
  /** Undefined means the default deadline. */
  sessionStartTimeoutMs?: number | undefined;
  createSession(
    id: string,
    client: ClientSink,
    options: { skipGreeting: boolean; resumed: boolean },
  ): ServerSession;
};

/** Attach a session to `sink` and hand back its input half. */
export function connectSession(
  sink: ClientSink,
  options: SessionConnectOptions | undefined,
  deps: ConnectDeps,
): SessionConnection {
  const { resumeFrom, logContext, onSessionEnd, skipGreeting, audioLeadMs } = options ?? {};
  const { readyConfig } = deps;
  const paced = createPacedClientSink(sink, {
    sampleRate: readyConfig.ttsSampleRate,
    leadMs: audioLeadMs,
  });
  let attached: AttachedSession | null = null;
  /**
   * The far end is gone, whoever decided so. A socket adapter learns this from
   * its close event; a caller-owned sink has none, so when the RUNTIME closes
   * the sink — a resume takeover, a failed start — it detaches here too, or the
   * session would sit "ready" with nobody left to end it.
   */
  const detach = (reason?: string): void => {
    paced.stopPacing();
    attached?.detach(omitUndefined({ reason }));
  };
  const client: ClientSink = {
    get open() {
      return paced.client.open;
    },
    event: paced.client.event,
    playAudioChunk: paced.client.playAudioChunk,
    close(reason) {
      paced.client.close?.(reason);
      detach(reason);
    },
  };
  attached = attachSession(client, {
    sessions: deps.sessions,
    readyConfig,
    createSession: (id, c) => {
      const session = deps.createSession(id, c, {
        skipGreeting: skipGreeting ?? false,
        // A resume is what makes a history restore worth a round trip, and the
        // caller's own `resumeFrom` is the honest signal — the same rule the
        // socket path follows with its `?sessionId=`.
        resumed: resumeFrom !== undefined,
      });
      // A session stopped from OUTSIDE — `runtime.shutdown()` stops every live
      // session directly — ends this connection too. Without it `ended` never
      // settles, `onSessionEnd` never fires and the pacer's timer outlives the
      // runtime, because nothing else tells a caller-owned sink it is over.
      // `stop()` is idempotent, so the one `detach` then runs again is a no-op.
      const stop = session.stop.bind(session);
      session.stop = async () => {
        try {
          await stop();
        } finally {
          detach("session stopped");
        }
      };
      return session;
    },
    ...omitUndefined({
      logger: deps.logger,
      sessionStartTimeoutMs: deps.sessionStartTimeoutMs,
      logContext,
      resumeFrom,
    }),
    // The CALLER's sink, not the pacing wrapper around it: the sink is the
    // identity token `onSessionEnd` documents, and the wrapper is one the
    // caller has never seen and so could never compare against.
    ...omitUndefined({
      onSessionEnd: onSessionEnd && ((id: string) => onSessionEnd(id, sink)),
    }),
  });
  const connection = attached;
  return {
    id: connection.id,
    readyConfig,
    sendAudio: connection.sendAudio,
    sendCommand: connection.sendCommand,
    close: () => detach(),
    ended: connection.ended,
  };
}
