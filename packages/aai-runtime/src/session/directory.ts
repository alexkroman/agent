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
 * Two registries are kept: the session itself, and its WIRING — the client
 * sink, event emitter and token meter, claimed as one value so they can only
 * come off together:
 *
 * | registry | claimed by | read through |
 * | --- | --- | --- |
 * | the `ServerSession` | `attach.ts`, at resume takeover | {@link SessionDirectory.session}, {@link SessionDirectory.speech} |
 * | its {@link SessionWiring} | `../runtime/runtime.ts`'s `createSession` | {@link SessionDirectory.emitter} (`ctx.send`, a hook commit), {@link SessionDirectory.meter} (`ctx.generate`, `ctx.delegate`) |
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
import type { UsageMeter } from "../usage-meter.ts";
import type { ServerSession } from "./core-types.ts";
import type { SessionEmitter } from "./emitter.ts";
import { type SpeechDirectory, speechDirectory } from "./speech.ts";

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
   * socket is gone. The release answers whether this wiring was still owned.
   */
  claimWiring(sessionId: string, wiring: SessionWiring): () => boolean;
  /** The emitter of whichever session holds `sessionId` now. */
  emitter(sessionId: string): SessionEmitter | undefined;
  /** The token meter of whichever session holds `sessionId` now. */
  meter(sessionId: string): UsageMeter | undefined;
  /** `say` / `interrupt` / `announce` by id — see `speech.ts`. */
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
  const wirings = createOwnedMap<string, SessionWiring>();
  return {
    claim: (sessionId, session) => sessions.claim(sessionId, session),
    session: (sessionId) => sessions.get(sessionId),
    claimWiring: (sessionId, wiring) => wirings.claim(sessionId, wiring),
    emitter: (sessionId) => wirings.get(sessionId)?.emitter,
    meter: (sessionId) => wirings.get(sessionId)?.meter,
    speech: speechDirectory({ get: (sessionId) => sessions.get(sessionId) }),
    live: () => sessions.values(),
    ids: () => sessions.keys(),
    get size(): number {
      return sessions.size;
    },
    clear(): void {
      sessions.clear();
      wirings.clear();
    },
  };
}
