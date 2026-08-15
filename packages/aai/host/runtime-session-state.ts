// Copyright 2026 the AAI authors. MIT license.
/**
 * The runtime's session-state wiring: which backend, and where a session picks
 * its state up and puts it down.
 *
 * Split out of `runtime.ts` at the 500-line cap, along the seam that file
 * already had — everything here is about the lifetime of a session's slot
 * values, and `runtime.ts` is about transports and sinks. The store itself, its
 * two backends and the reason there are two live in `session-state-store.ts`.
 */

import type { Db } from "../sdk/db.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import type { Logger } from "./runtime-config.ts";
import type { SessionCore } from "./session-core.ts";
import { createPostgresStateBackend } from "./session-state-postgres.ts";
import {
  createMemoryStateBackend,
  createSessionStateStore,
  type SessionStateStore,
} from "./session-state-store.ts";
import { createStateSweeps, type StateSweeps } from "./session-state-sweeps.ts";

/** The store, its grace-window sweeps, and the line an operator reads at boot. */
export type RuntimeSessionState = {
  store: SessionStateStore;
  sweeps: StateSweeps;
  /**
   * What `createRuntime` puts in "Session mode resolved".
   *
   * Reported there rather than nowhere because which backend an agent gets is a
   * property of the DEPLOYMENT — `provisionAppDatabase` has exactly one caller,
   * the storage-enable route — so "is this agent's state durable" is otherwise
   * unanswerable from outside the process, and the memory tier is today's silent
   * loss rather than a new behaviour.
   */
  describe: { backend: string; durable: boolean };
};

/**
 * Build the runtime's session-state store: Postgres when the app has a database,
 * memory otherwise.
 *
 * @internal
 */
export function createRuntimeSessionState(opts: {
  db: Db | undefined;
  logger: Logger;
}): RuntimeSessionState {
  const store = createSessionStateStore({
    backend: opts.db ? createPostgresStateBackend({ db: opts.db }) : createMemoryStateBackend(),
    logger: opts.logger,
  });
  return {
    store,
    sweeps: createStateSweeps(store),
    describe: { backend: store.backend.name, durable: store.backend.durable },
  };
}

/**
 * Wrap one session's `start` and `stop` so its state is picked up on the way in
 * and released on the way out.
 *
 * ## Hydration goes INSIDE the `session.start()` window
 *
 * That window is the one seam that fits. `ws-handler` sends `config`
 * synchronously at zero RTT and only then calls `start()`, which is bounded by
 * `DEFAULT_SESSION_START_TIMEOUT_MS` with inbound audio buffered until it
 * resolves — so hydrating here is AFTER the client's handshake guard (which
 * treats a socket carrying nothing as an unhealthy peer rather than a slow one)
 * and BEFORE the session is ready, meaning no tool can observe unhydrated state.
 * A rejection takes the existing failure path, which already tears the session
 * down and tells the client.
 *
 * It cannot be lazy instead: `slot.get` is synchronous and every caller assumes
 * it, so there is no first-tool-call await to hang a load off.
 *
 * Paid only on a RESUME — a fresh session's load finds nothing — and wrapped
 * here rather than in `ws-handler` so a direct `runtime.createSession()` caller
 * gets it too.
 *
 * ## Reclamation is tied to the session's own `stop()`
 *
 * So it happens on every teardown path, including a direct
 * `runtime.createSession()` caller that never goes through `startSession`'s
 * `onSessionEnd` hook. `releaseSink` guards the reconnect-resume race: an old
 * session's async `stop()` can settle after a resumed session re-claimed the
 * same id, and a bare key delete would then wipe the NEW session's sink and
 * state — release-by-claim returns false once that has happened.
 *
 * @internal
 */
export function attachSessionState(
  core: SessionCore,
  opts: {
    state: RuntimeSessionState;
    sessionId: string;
    client: ClientSink;
    /** Releases this session's sink claim; false once a resume superseded it. */
    releaseSink: () => boolean;
    /** `pushStateSnapshot`, absent on the sandbox path where the runtime holds no state. */
    pushStateSnapshot?: ((sessionId: string, sink: ClientSink) => void) | undefined;
  },
): void {
  const { state, sessionId, client, releaseSink, pushStateSnapshot } = opts;
  const startCore = core.start.bind(core);
  core.start = async () => {
    await state.store.hydrate(sessionId);
    // AFTER hydration, which is the whole ordering. A resume onto a REPLACEMENT
    // process has an empty cache until the load lands, so pushing before it would
    // find no state, report nothing, and leave the reconnected client rendering
    // empty until some later tool call happened to change something — which it
    // may never do. That is the bug this call exists to prevent, reached by a new
    // route.
    pushStateSnapshot?.(sessionId, client);
    await startCore();
  };

  const stopCore = core.stop.bind(core);
  core.stop = async () => {
    try {
      await stopCore();
    } finally {
      if (releaseSink()) {
        // Slot state outlives the socket: keep it for the resume grace window so
        // a `?sessionId=<id>` reconnect finds it.
        state.sweeps.schedule(sessionId);
      }
    }
  };
}
