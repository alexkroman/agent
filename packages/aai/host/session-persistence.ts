// Copyright 2026 the AAI authors. MIT license.
/**
 * The runtime's half of durable resume — mirroring per-session state to a
 * {@link SessionStore} and reading it back when a resume finds nothing live.
 *
 * Split from runtime.ts because it is a whole mechanism (a per-session
 * coalescing writer, a hydration step ordered against `session.start()`, and
 * the provider-session-id relay) rather than a few lines of wiring, and
 * runtime.ts is already at its length cap.
 *
 * **The store is never on the hot path.** `getState` keeps handing tool code
 * the live object it mutates in place, and this module writes a serialized
 * copy behind {@link createCoalescingRunner} — so N mutations during one
 * settling write collapse into one trailing write, and a rejected write never
 * wedges the next. With no store configured every method here is inert and the
 * runtime behaves exactly as it did before.
 */

import { type CoalescingRunner, createCoalescingRunner } from "../sdk/coalescing-runner.ts";
import type { Db } from "../sdk/db.ts";
import { errorMessage } from "../sdk/utils.ts";
import type { Logger } from "./runtime-config.ts";
import {
  resolveSessionStore,
  type SessionSnapshot,
  type SessionStore,
  serializeSnapshot,
} from "./session-store.ts";

/** What {@link createSessionPersistence} needs from the runtime. */
export type SessionPersistenceDeps = {
  /**
   * A store the caller injected. Wins over `persistSessions`, and is the only
   * way a runtime with no database persists at all.
   */
  sessionStore: SessionStore | undefined;
  /** The agent's `persistSessions` opt-in. */
  persistSessions?: boolean | undefined;
  /** The runtime's resolved `ctx.db` handle; undefined when storage is off. */
  db?: Db | undefined;
  /** The runtime's live per-session `ctx.state` map — hydration installs into it. */
  stateMap: Map<string, Record<string, unknown>>;
  logger: Logger;
};

/**
 * The provider-session hooks a transport needs, in the shape
 * `TransportSessionOpts` carries them.
 */
export type ProviderSessionHooks = {
  /**
   * The provider session id a COLD resume should present, read at connect
   * time. A thunk rather than a value because the transport is constructed
   * synchronously from the socket's `open` handler, while hydration is async
   * and finishes inside `start()` — a value captured at construction would
   * always be the pre-hydration one, i.e. always absent.
   */
  resumeProviderSession: () => string | undefined;
  /** Called with each `session.ready` id, so the next resume can present it. */
  onProviderSession: (providerSessionId: string) => void;
};

/**
 * The slice of a `SessionCore` {@link SessionPersistence.wrapStart} needs — it
 * replaces exactly one method and reads nothing else, and naming that keeps a
 * test double from having to be cast into a whole SessionCore.
 */
export type StartableSession = { start(): Promise<void> };

/** The runtime-facing surface of durable resume. */
export type SessionPersistence = {
  /**
   * Make `core.start()` hydrate first: a resumed session with no live state
   * reads its snapshot before the transport connects, so the provider-session
   * id is available to a cold resume and `ctx.state` is populated before the
   * first tool call. `afterHydrate` runs once hydration settles and before
   * `start()`, for the client-facing state snapshot push.
   */
  wrapStart(core: StartableSession, sessionId: string, afterHydrate: () => void): void;
  /** Note that `sessionId`'s state changed; schedules a coalesced write. */
  touch(sessionId: string): void;
  /** The transport hooks for `sessionId`. */
  providerSession(sessionId: string): ProviderSessionHooks;
  /** Reclaim `sessionId` — the resume grace window expired. */
  forget(sessionId: string): void;
};

/** A persistence that does nothing, for a runtime with no store configured. */
function inertPersistence(): SessionPersistence {
  return {
    wrapStart: () => undefined,
    touch: () => undefined,
    providerSession: () => ({
      resumeProviderSession: () => undefined,
      onProviderSession: () => undefined,
    }),
    forget: () => undefined,
  };
}

/**
 * Create the runtime's {@link SessionPersistence}.
 *
 * @internal
 */
export function createSessionPersistence(deps: SessionPersistenceDeps): SessionPersistence {
  const store = resolveSessionStore({
    explicit: deps.sessionStore,
    persistSessions: deps.persistSessions,
    db: deps.db,
    logger: deps.logger,
  });
  // Split rather than guarded inline so the implementation below takes a
  // non-optional store: TypeScript does not carry a narrowing into the
  // closures this builds, and the alternative is a non-null assertion at
  // every use.
  return store === undefined ? inertPersistence() : storePersistence(store, deps);
}

/** The real implementation, for a runtime that resolved a store. */
function storePersistence(
  store: SessionStore,
  deps: Pick<SessionPersistenceDeps, "stateMap" | "logger">,
): SessionPersistence {
  const { stateMap, logger } = deps;

  /** Provider session ids, by our own session id. */
  const providerIds = new Map<string, string>();
  /** One coalescing writer per session, so two sessions never serialize each other. */
  const writers = new Map<string, CoalescingRunner<void>>();
  /** Last JSON written per session — the dedupe key, see `serializeSnapshot`. */
  const lastWritten = new Map<string, string>();
  /**
   * Sessions whose state cannot be serialized. Latched so the warning is one
   * line per session rather than one per tool call — the condition is a
   * property of the agent's state shape, so it does not clear on its own.
   */
  const unserializable = new Set<string>();

  function snapshotOf(sessionId: string): SessionSnapshot | null {
    const state = stateMap.get(sessionId);
    const providerSessionId = providerIds.get(sessionId);
    // Nothing a resume could use. A session holding only a provider id IS
    // real — S2S connects before any tool call — so an empty object stands in
    // for the state half rather than suppressing the write.
    if (state === undefined && providerSessionId === undefined) return null;
    return {
      state: state ?? {},
      ...(providerSessionId !== undefined ? { providerSessionId } : {}),
    };
  }

  /** The snapshot's JSON, or null when there is nothing to write (warning once). */
  function pendingWrite(sessionId: string, snapshot: SessionSnapshot): string | null {
    const serialized = serializeSnapshot(snapshot);
    if ("error" in serialized) {
      if (!unserializable.has(sessionId)) {
        unserializable.add(sessionId);
        logger.warn("Session state is not serializable; it will not survive a restart", {
          sid: sessionId.slice(0, 8),
          error: serialized.error,
        });
      }
      return null;
    }
    // Most tool calls never touch state, and `touch` runs after every one of
    // them — without this each would cost an upsert writing back what is
    // already there.
    return lastWritten.get(sessionId) === serialized.json ? null : serialized.json;
  }

  function writerFor(sessionId: string): CoalescingRunner<void> {
    let writer = writers.get(sessionId);
    if (writer === undefined) {
      writer = createCoalescingRunner(async () => {
        // Re-read at RUN time, never at trigger time: that is what makes
        // collapsing N triggers into one write correct.
        const snapshot = snapshotOf(sessionId);
        if (snapshot === null) return;
        const json = pendingWrite(sessionId, snapshot);
        if (json === null) return;
        await store.save(sessionId, snapshot);
        // Recorded only after the write lands, so a failed write is retried by
        // the next touch rather than deduped away.
        lastWritten.set(sessionId, json);
      });
      writers.set(sessionId, writer);
    }
    return writer;
  }

  function touch(sessionId: string): void {
    // Fire-and-forget by design — a session must not wait on its own
    // bookkeeping. A failed write is logged and dropped: the next touch
    // starts a fresh run, and the cost of losing one is a resume that starts
    // from an older snapshot, never a broken session.
    void writerFor(sessionId)
      .trigger()
      .catch((err: unknown) => {
        logger.warn("Session state write failed", {
          sid: sessionId.slice(0, 8),
          error: errorMessage(err),
        });
      });
  }

  async function hydrate(sessionId: string): Promise<void> {
    // A live entry means this process still holds the session — the socket
    // dropped, not the process. That copy is authoritative and newer than
    // anything stored, so reading over it would roll the session back.
    if (stateMap.has(sessionId)) return;
    let snapshot: Awaited<ReturnType<SessionStore["load"]>>;
    try {
      snapshot = await store.load(sessionId);
    } catch (err) {
      // A store that cannot be read is a session that starts fresh, which is
      // the pre-store behaviour — never a session that fails to start.
      logger.warn("Session state load failed; starting fresh", {
        sid: sessionId.slice(0, 8),
        error: errorMessage(err),
      });
      return;
    }
    if (snapshot === null) return;
    stateMap.set(sessionId, snapshot.state);
    if (snapshot.providerSessionId !== undefined) {
      providerIds.set(sessionId, snapshot.providerSessionId);
    }
    logger.info("Session state restored", {
      sid: sessionId.slice(0, 8),
      providerSession: snapshot.providerSessionId ?? "none",
    });
  }

  return {
    wrapStart(core, sessionId, afterHydrate) {
      const startCore = core.start.bind(core);
      core.start = async () => {
        await hydrate(sessionId);
        afterHydrate();
        await startCore();
      };
    },

    touch,

    providerSession(sessionId) {
      return {
        resumeProviderSession: () => providerIds.get(sessionId),
        onProviderSession: (providerSessionId) => {
          if (providerIds.get(sessionId) === providerSessionId) return;
          providerIds.set(sessionId, providerSessionId);
          // Persist immediately rather than waiting for a tool call: an S2S
          // session that never calls a tool still has the one thing a cold
          // resume needs, and a call can run for minutes before the first.
          touch(sessionId);
        },
      };
    },

    forget(sessionId) {
      providerIds.delete(sessionId);
      writers.delete(sessionId);
      lastWritten.delete(sessionId);
      unserializable.delete(sessionId);
      void store.delete(sessionId).catch((err: unknown) => {
        logger.warn("Session state delete failed", {
          sid: sessionId.slice(0, 8),
          error: errorMessage(err),
        });
      });
    },
  };
}
