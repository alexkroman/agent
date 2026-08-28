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

import type { Db } from "@alexkroman1/aai/internal";
import type { Logger } from "./runtime-config.ts";
import type { SessionCore } from "./session-core.ts";
import type { SessionEmitter } from "./session-emitter.ts";
import { createSessionEventStream, type SessionEventStream } from "./session-event-stream.ts";
import type { ResumeFindings } from "./session-resume-found.ts";
import {
  createPlatformStateBackend,
  type PlatformSessionStateOptions,
} from "./session-state-platform.ts";
import { createPostgresStateBackend } from "./session-state-postgres.ts";
import {
  createMemoryStateBackend,
  createSessionStateStore,
  type SessionStateBackend,
  type SessionStateStore,
} from "./session-state-store.ts";
import { createStateSweeps, type StateSweeps } from "./session-state-sweeps.ts";

/** The store, its grace-window sweeps, and the line an operator reads at boot. */
export type RuntimeSessionState = {
  store: SessionStateStore;
  /**
   * The session event stream, over the SAME backend as `store`.
   *
   * Here rather than in its own factory because the backend is the thing that
   * must not be built twice: two selection rules could disagree about whether an
   * agent is durable, and two `discard`s would reclaim half a session each. See
   * `session-state-store.ts` on the two consumers.
   */
  stream: SessionEventStream;
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
 * The tiers, in order.
 *
 * A function rather than a nested ternary so each branch can carry its own reason —
 * which is what a reader of "Session mode resolved" needs when they are asking why
 * an agent is in the tier it is in.
 */
function selectBackend(opts: {
  db: Db | undefined;
  logger: Logger;
  platform?: PlatformSessionStateOptions | undefined;
}): SessionStateBackend {
  // FIRST, and it wins over a `DATABASE_URL` for the same reason the platform WORLD
  // does: a deployed agent's durability should not depend on whether it happens to
  // have provisioned a database.
  if (opts.platform) return createPlatformStateBackend(opts.platform);
  // A self-hosted server, or `aai dev` against a project with a database.
  if (opts.db) return createPostgresStateBackend({ db: opts.db });
  // `aai dev` with no database. A restart forgets the turn, which is the honest
  // trade and what `durable: false` in the resolved line reports.
  return createMemoryStateBackend();
}

/**
 * Build the runtime's session-state store.
 *
 * THREE tiers, in this order, and the order is the decision:
 *
 * 1. **Platform** when this guest was spawned by one — session state on the
 *    platform's own database, over HTTP. It wins over a `DATABASE_URL` for the same
 *    reason the platform WORLD does: a deployed agent's durability should not depend
 *    on whether it happens to have provisioned a database.
 * 2. **Postgres** against `ctx.db` — a self-hosted server, or `aai dev` with one.
 * 3. **Memory**, where a restart forgets the turn. `aai dev` with no database.
 *
 * @internal
 */
export function createRuntimeSessionState(opts: {
  db: Db | undefined;
  logger: Logger;
  /** The platform's session-state endpoint, when this guest has one. */
  platform?: PlatformSessionStateOptions | undefined;
}): RuntimeSessionState {
  const backend = selectBackend(opts);
  const store = createSessionStateStore({ backend, logger: opts.logger });
  return {
    store,
    stream: createSessionEventStream({ backend, logger: opts.logger }),
    sweeps: createStateSweeps(store),
    describe: { backend: backend.name, durable: backend.durable },
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
 * `onSessionEnd` hook. `release` guards the reconnect-resume race: an old
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
    /** This session's event emitter — what a forced state snapshot is pushed through. */
    emitter: SessionEmitter;
    /** Releases this session's claims on its id; false once a resume superseded them. */
    release: () => boolean;
    /** `pushStateSnapshot`, absent on the sandbox path where the runtime holds no state. */
    pushStateSnapshot?: ((sessionId: string, emitter: SessionEmitter) => void) | undefined;
    /**
     * Where "this resume hydrated real state" is recorded — see
     * `session-resume-found.ts`. The same question `pushStateSnapshot` gates on,
     * read one line later so the greeting can use the answer too.
     */
    findings?: ResumeFindings | undefined;
  },
): void {
  const { state, sessionId, emitter, release, pushStateSnapshot, findings } = opts;
  const startCore = core.start.bind(core);
  core.start = async () => {
    await state.store.hydrate(sessionId);
    // AFTER the hydrate, for the same reason the push below is: before it the
    // cache is empty on a replacement process and this would report nothing.
    if (state.store.has(sessionId)) findings?.record();
    // AFTER hydration, which is the whole ordering. A resume onto a REPLACEMENT
    // process has an empty cache until the load lands, so pushing before it would
    // find no state, report nothing, and leave the reconnected client rendering
    // empty until some later tool call happened to change something — which it
    // may never do. That is the bug this call exists to prevent, reached by a new
    // route.
    pushStateSnapshot?.(sessionId, emitter);
    await startCore();
  };

  const stopCore = core.stop.bind(core);
  core.stop = async () => {
    try {
      await stopCore();
    } finally {
      if (release()) {
        // Slot state outlives the socket: keep it for the resume grace window so
        // a `?sessionId=<id>` reconnect finds it.
        state.sweeps.schedule(sessionId);
      }
    }
  };
}
