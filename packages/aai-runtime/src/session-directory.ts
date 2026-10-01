// Copyright 2026 the AAI authors. MIT license.
/**
 * The runtime's ONE directory of live sessions, by id — and so the one place
 * resume semantics live.
 *
 * A session id outlives the `ServerSession` holding it: a reconnect resuming
 * the id claims it while the old session's `stop()` still drains, and a timer,
 * a webhook, a straggling tool call or a run's `notify` can reach for the id
 * after the swap. Every such reach is answered HERE, per call, by whatever
 * holds the id at that moment — never by a session object captured earlier.
 * Four registries are kept, one per thing a session claims under its id:
 *
 * | registry | claimed by | read through |
 * | --- | --- | --- |
 * | the `ServerSession` | `session-attach.ts`, at resume takeover | {@link SessionDirectory.session}, {@link SessionDirectory.speech} |
 * | the client sink | `runtime.ts`'s `createSession` | (released with the session's wiring) |
 * | the event emitter | `runtime.ts`'s `createSession` | {@link SessionDirectory.emitter} (`ctx.send`, a hook commit) |
 * | the token meter | `runtime.ts`'s `createSession` | {@link SessionDirectory.meter} (`ctx.generate`, `ctx.delegate`) |
 *
 * Each is an `OwnedMap` (`sdk/owned-map.ts`): a claim's release deletes the
 * entry only while that claim still owns it, which is what keeps an old
 * session's late teardown from evicting its successor. **No module outside
 * this one holds such a map** — `guard-invariants` rule 36 refuses an
 * `OwnedMap` over a session-keyed value anywhere else, because a second map is
 * a second copy of the resume rule.
 *
 * @module
 */

import { createOwnedMap } from "@alexkroman1/aai/internal";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import type { ServerSession } from "./session-core-types.ts";
import type { SessionEmitter } from "./session-emitter.ts";
import { type SpeechDirectory, speechDirectory } from "./session-speech.ts";
import type { UsageMeter } from "./usage-meter.ts";

/** What one session claims under its id beside the session itself. @internal */
export type SessionWiring = {
  sink: ClientSink;
  emitter: SessionEmitter;
  meter: UsageMeter;
};

/** See this module's header. @internal */
export type SessionDirectory = {
  /**
   * Install `session` under `sessionId`, replacing whatever holds it (a
   * resume's takeover). The release deletes the entry only while THIS claim
   * still owns it, and reports whether it did.
   */
  claim(sessionId: string, session: ServerSession): () => boolean;
  /** The session holding `sessionId` NOW, if any. */
  session(sessionId: string): ServerSession | undefined;
  /**
   * Claim a session's sink, emitter and meter together — one session's hold
   * on one id, so they come off together: releasing only the sink would
   * leave a straggling tool call's `ctx.send` resolving an emitter whose
   * socket is gone. The release answers whether the SINK was still owned.
   */
  claimWiring(sessionId: string, wiring: SessionWiring): () => boolean;
  /** The emitter of whichever session holds `sessionId` now. */
  emitter(sessionId: string): SessionEmitter | undefined;
  /** The token meter of whichever session holds `sessionId` now. */
  meter(sessionId: string): UsageMeter | undefined;
  /** `say` / `interrupt` / `announce` by id — see `session-speech.ts`. */
  readonly speech: SpeechDirectory;
  /** Every live session, for shutdown. */
  live(): IterableIterator<ServerSession>;
  /** Every live session id. */
  ids(): IterableIterator<string>;
  /** How many sessions are live. */
  readonly size: number;
  /** Drop every registry — the runtime is shutting down. */
  clear(): void;
};

/** Build an empty {@link SessionDirectory}. @internal */
export function createSessionDirectory(): SessionDirectory {
  const sessions = createOwnedMap<string, ServerSession>();
  const sinks = createOwnedMap<string, ClientSink>();
  const emitters = createOwnedMap<string, SessionEmitter>();
  const meters = createOwnedMap<string, UsageMeter>();
  return {
    claim: (sessionId, session) => sessions.claim(sessionId, session),
    session: (sessionId) => sessions.get(sessionId),
    claimWiring(sessionId, wiring) {
      const releaseSink = sinks.claim(sessionId, wiring.sink);
      const releaseEmitter = emitters.claim(sessionId, wiring.emitter);
      const releaseMeter = meters.claim(sessionId, wiring.meter);
      return () => {
        const owned = releaseSink();
        releaseEmitter();
        releaseMeter();
        return owned;
      };
    },
    emitter: (sessionId) => emitters.get(sessionId),
    meter: (sessionId) => meters.get(sessionId),
    speech: speechDirectory({ get: (sessionId) => sessions.get(sessionId) }),
    live: () => sessions.values(),
    ids: () => sessions.keys(),
    get size(): number {
      return sessions.size;
    },
    clear(): void {
      sessions.clear();
      sinks.clear();
      emitters.clear();
      meters.clear();
    },
  };
}
