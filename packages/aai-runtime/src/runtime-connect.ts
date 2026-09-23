// Copyright 2026 the AAI authors. MIT license.
/**
 * `connectSession` — a session over a caller-owned {@link ClientSink}.
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
import type { Runtime, SessionConnection, SessionConnectOptions } from "./runtime-types.ts";
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

/**
 * What each runtime `createRuntime` built hands this module, keyed by the
 * handle. A `WeakMap` rather than a member on {@link Runtime}: the handle is
 * sealed, and a connection needs the runtime's session table and factory, which
 * are not the caller's business to see.
 */
const connectors = new WeakMap<Runtime, ConnectDeps>();

/** Record what {@link connectSession} needs for `runtime`. Called once, by `createRuntime`. */
export function registerConnector(runtime: Runtime, deps: ConnectDeps): void {
  connectors.set(runtime, deps);
}

/**
 * Run a session over your OWN audio I/O — anything that is not a WebSocket.
 *
 * `runtime.startSession` takes a socket speaking the client protocol; this
 * takes the two halves of that protocol directly. The session writes to `sink`
 * (events, and agent audio as PCM16 mono at `readyConfig.ttsSampleRate`) and
 * you write to the returned {@link SessionConnection} (user audio as PCM16 mono
 * at `readyConfig.sampleRate`, plus client commands). Everything else a browser
 * session gets comes with it: the start deadline, input buffered while the
 * session starts, real-time pacing of agent audio with its barge-in ordering
 * rules, resume by id, and end-of-session cleanup.
 *
 * The session announces itself on `sink` (`session.configured`) before this
 * returns. Send `{ type: "audio_ready" }` once you can play audio — that is
 * what releases the greeting — and call `close()` when your end goes away.
 *
 * A free function over the handle rather than a `Runtime.connect` method, so
 * the handle a caller receives stays sealed and this is versioned on its own
 * signature.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { connectSession, createRuntime } from "@alexkroman1/aai-runtime";
 *
 * const runtime = createRuntime({ agent: agent({ name: "Desk" }), env: {} });
 * declare function play(pcm: Uint8Array): void;
 * declare function flushPlayback(): void;
 *
 * const connection = connectSession(runtime, {
 *   open: true,
 *   event(e) {
 *     if (e.type === "reply.cancelled") flushPlayback();
 *   },
 *   playAudioChunk: play,
 * });
 * connection.sendCommand({ type: "audio_ready" });
 * // …feed microphone PCM16 at runtime.readyConfig.sampleRate:
 * connection.sendAudio(new Uint8Array(3200));
 * connection.close();
 * await connection.ended;
 * ```
 *
 * @public
 */
export function connectSession(
  runtime: Runtime,
  sink: ClientSink,
  options?: SessionConnectOptions,
): SessionConnection {
  const deps = connectors.get(runtime);
  if (deps === undefined) {
    throw new TypeError(
      "connectSession: this runtime was not built by createRuntime() from this copy of " +
        "@alexkroman1/aai-runtime",
    );
  }
  return attachConnection(sink, options, deps);
}

/** Attach a session to `sink` and hand back its input half. */
function attachConnection(
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
