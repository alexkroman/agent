// Copyright 2026 the AAI authors. MIT license.
/**
 * One session-state store, with two backends.
 *
 * A slot's value used to live in a `Map` in the runtime's heap and died with the
 * process, so a crash or a redeploy handed a reconnecting caller an agent that
 * remembered the whole conversation and had forgotten its cart. Three platform
 * paths make that routine rather than exceptional: `handoverSlot`'s blue-green
 * redeploy, the fleet-wide peer route a cold broker takes when another replica
 * is already serving the deploy, and an idle guest that self-exited.
 *
 * ## The shape: one cache, two backends
 *
 * `SessionSlot.get` is SYNCHRONOUS and every caller assumes it, so a read can
 * never be a query. The store is therefore an in-process cache of hydrated
 * values — that is the thing a slot reads and writes — in front of an async
 * {@link SessionStateBackend}:
 *
 * - **Platform** when the guest was spawned by one, reached over HTTP with the
 *   per-sandbox bearer. What a DEPLOYED agent gets, and it needs no database of its
 *   own — see `session-state-platform.ts`.
 * - **Postgres** when the app has a database (`DATABASE_URL`), one row per
 *   `(sessionId, slot)` in the app's own database. A self-hosted server, or
 *   `aai dev` against a project with one.
 * - **Memory** otherwise, which is what `aai dev` against a project with no
 *   `DATABASE_URL` gets, and what a deployed agent nobody enabled storage for
 *   gets. This REPLACES the runtime's old `stateMap` rather than sitting beside
 *   it.
 *
 * Selected by environment, which is the shape this repo already uses twice
 * (`configureWorkflowWorld`, the workflow upload store). A per-SLOT `persist`
 * flag was the first design and is refused: an in-memory store holds JS objects,
 * so it cannot represent an encoding bug, and a flag would mean every test
 * against a memory-backed slot passed on shapes Postgres cannot hold. The
 * storability check (`sdk/session-state.ts`) runs in BOTH, which is the whole
 * reason the memory backend is a valid test double for the Postgres one.
 *
 * ## When a write is committed
 *
 * At the END OF THE TOOL CALL, awaited, once per changed slot — not per
 * mutation. `slot.update` is synchronous by contract, so it cannot await a
 * commit itself; the runtime flushes in the same `finally` that pushes
 * `syncState` (`host/runtime-tools.ts`). That is also the cheap end: retail
 * mutates ~106 KB of state on nearly every tool call, and a per-mutation commit
 * would write all of it several times per call.
 *
 * Awaited rather than fire-and-forget, because fire-and-forget drops exactly the
 * writes a crash is supposed to preserve. One commit is roughly one query
 * against a tool turn that already averages ~6.2s.
 *
 * ## The size cap
 *
 * {@link MAX_SESSION_STATE_BYTES} bounds one slot's serialized value, and it is a
 * DIFFERENT budget from `MAX_CLIENT_EVENT_PAYLOAD_BYTES` on purpose. That one
 * bounds what crosses a socket already carrying 384 kbps of PCM, hence 64 KiB;
 * this bounds what one session may leave in the TENANT's own Postgres schema —
 * which `appDatabaseUsage` counts and the studio shows an author as their own
 * database usage — so the two answer to different pressures and should not share a
 * number. The largest state any template holds is retail's ~106 KB store, so 1 MiB
 * leaves an order of magnitude of headroom while still bounding a runaway append.
 *
 * Exceeding it costs DURABILITY, not correctness: the in-memory value is still
 * right and the tool's result unaffected, so the failure is an `error` log naming
 * the slot and its size.
 */

import type { SlotStore } from "@alexkroman1/aai";
import { freezeStorable, MAX_SESSION_STATE_BYTES } from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import { getOrCreate } from "./_get-or-create.ts";
import type { StateSyncSession } from "./_state-sync.ts";
import type { Logger } from "./runtime-config.ts";

/** One retained session event: its index in the session's log, and its JSON. */
export type StoredSessionEvent = {
  /** Position in this session's log, from 0. The stream's only cursor. */
  index: number;
  /** The serialized `SessionEvent` (`@alexkroman1/aai/protocol`), envelope included. */
  json: string;
};

/**
 * Where a session's durable things are kept between processes — its slot values
 * AND its event log.
 *
 * Values cross this boundary as SERIALIZED JSON, deliberately: the cache above
 * it holds objects, and a backend that took objects could not be told apart
 * from the cache when the encoding is what breaks.
 *
 * **Two consumers, one backend, and that is the design rather than an
 * accident.** The event stream needs exactly what slot state needs — Postgres
 * when the app has a database, memory otherwise, reclaimed when the session is
 * — so it is a second consumer of THIS interface instead of a second store with
 * its own selection rule, its own sweep and its own answer to "is this agent
 * durable".
 *
 * **`discard` reclaims BOTH, on every backend.** This sentence used to say
 * "what the backend is ALLOWED to reclaim, which is not always both", and the
 * hedge was the bug: the Postgres backend dropped slots only while the other two
 * dropped both, so "discarded" meant two different things depending on where a
 * session ran and nothing failed. The append-only GRANT that justified the
 * asymmetry went with per-app databases. `session-state-conformance.ts` carries
 * the decision and asserts it as a shared case on every arm; the retention sweep
 * stays as the backstop for a session whose guest died before it discarded.
 *
 * @public
 */
export type SessionStateBackend = {
  /**
   * For the "Session mode resolved" log line — an operator's only clue which tier
   * an agent is in.
   *
   * `platform` is the third: session state on the PLATFORM's database, reached over
   * HTTP, which is what a deployed guest gets once no agent has a database of its
   * own (`session-state-platform.ts`).
   */
  readonly name: "memory" | "postgres" | "platform";
  /** Whether a value written here survives this process. */
  readonly durable: boolean;
  /** Every stored slot for `sessionId`, keyed by slot. */
  load(sessionId: string): Promise<Map<string, string>>;
  /** Store these slots' values. Called with only the ones that changed. */
  commit(sessionId: string, values: ReadonlyMap<string, string>): Promise<void>;
  /** Reclaim this session's slots, and its events where the backend may. */
  discard(sessionId: string): Promise<void>;
  /**
   * Append these events at the indices they already carry.
   *
   * Indices are assigned by the log ABOVE this, synchronously, so a backend
   * never invents one — which is what lets a client be told its position before
   * the write lands. Appending an index that is already stored is a no-op
   * rather than an error: a retried flush after a partial failure must not be
   * the thing that breaks a call.
   */
  appendEvents(sessionId: string, events: readonly StoredSessionEvent[]): Promise<void>;
  /** Events from `startIndex` (inclusive), in index order, at most `limit`. */
  readEvents(
    sessionId: string,
    startIndex: number,
    limit: number,
  ): Promise<readonly StoredSessionEvent[]>;
  /**
   * The next free index for `sessionId` — one past the HIGHEST stored index,
   * which is not the same thing as how many are stored.
   *
   * Read on hydrate so a session resuming onto a REPLACEMENT process continues
   * its log rather than restarting at 0 and overwriting its own history. A count
   * only answers that for a log dense from zero, and this one need not be: an
   * event past `MAX_SESSION_EVENTS` advances the position without being stored,
   * and a partly-failed flush leaves a hole. Under a count both cases hand a
   * resumed session an index it has already used, so its `tail` goes BACKWARDS
   * and the re-used appends are silently dropped by `on conflict do nothing`.
   * Both backends must answer `max + 1`, or the memory one stops being a valid
   * double for the Postgres one.
   */
  countEvents(sessionId: string): Promise<number>;
};

/** The runtime's view of the store. */
export type SessionStateStore = {
  /** This session's {@link SlotStore} — what a tool's `ctx.slots` is. */
  viewFor(sessionId: string): SlotStore;
  /**
   * Load `sessionId`'s stored values into the cache. Paid only on a RESUME: a
   * fresh session has nothing to load, and the backend answers empty.
   *
   * Rejects on a backend failure, which the caller turns into a failed session
   * start. Shape drift is NOT a failure — see `createSessionStateStore`'s doc.
   */
  hydrate(sessionId: string): Promise<void>;
  /** Commit whatever this session changed. Never rejects; a failure is logged. */
  flush(sessionId: string): Promise<void>;
  /**
   * Has this session any state at all — i.e. has it run a tool call, or resumed
   * onto stored values? What `pushStateSnapshot` reads to tell a resume from a
   * fresh connection.
   */
  has(sessionId: string): boolean;
  /** This session as `syncState` reads and records it. */
  syncSession(sessionId: string): StateSyncSession;
  /** Reclaim a session: the cache entry AND the stored rows (the grace sweep). */
  discard(sessionId: string): void;
  /** Drop every cache entry (runtime shutdown). Stored rows are left alone. */
  clear(): void;
  /** Which backend is in play, for the resolved-providers log. */
  readonly backend: Pick<SessionStateBackend, "name" | "durable">;
};

/** One session's cached slots, plus what still needs writing. */
type SessionEntry = {
  values: Map<string, unknown>;
  /** Slots written since the last successful commit. */
  dirty: Set<string>;
  /** Last committed serialization per slot, so an unchanged value is not rewritten. */
  committed: Map<string, string>;
  /**
   * The `syncState` frame last pushed to this session's client.
   *
   * It lives here rather than in `_state-sync.ts` because it has the same
   * lifetime as the values it is derived from, and this is what reclaims them —
   * one sweep instead of two. See that module's header.
   */
  lastPush?: string;
};

/**
 * The memory backend, from the module that now declares it.
 *
 * Re-exported here rather than moved out from under its importers: this is the
 * module that declares the interface, so it is where a reader looks for the
 * reference implementation of it. `session-state-memory.ts`'s own header has
 * why it left — the conformance registry's one-file-per-backend grammar, and
 * this file's 500-line cap.
 */
export { createMemoryStateBackend } from "./session-state-memory.ts";

/**
 * Install one stored slot into the cache, or drop it with a warning.
 *
 * Its own function because the fail-open rule is the interesting decision here
 * and it deserves to be readable on its own — see
 * `createSessionStateStore`'s doc for why a value the running code cannot
 * make sense of is discarded rather than refused.
 */
function hydrateOne(
  entry: SessionEntry,
  key: string,
  json: string,
  sessionId: string,
  logger: Logger | undefined,
): void {
  // A slot already written in this process wins: hydration runs before the
  // session is ready, but a direct caller could have touched it, and the live
  // value is the newer one.
  if (entry.values.has(key)) return;
  try {
    const value: unknown = JSON.parse(json);
    // Frozen on the way in, exactly as a write would: a hydrated value is handed
    // to the same `get` and must behave the same. A value that parses but holds a
    // shape this code cannot store — impossible from our own writer, reachable
    // from a hand-edited row — fails here and takes the fail-open path.
    entry.values.set(key, freezeStorable(value, key));
    entry.committed.set(key, json);
  } catch (err: unknown) {
    logger?.warn?.("Stored session state dropped", {
      sessionId,
      slot: key,
      error: errorMessage(err),
    });
  }
}

/**
 * One slot's value as it should be COMMITTED, or `undefined` for the three ways
 * there is nothing to write: unchanged, unserializable, over the size cap.
 *
 * Its own function because `flush`'s job is the round trip and the dirty-set
 * bookkeeping, and each of these three is a decision with its own log line.
 */
function serializeForCommit(
  entry: SessionEntry,
  key: string,
  sessionId: string,
  logger: Logger | undefined,
): string | undefined {
  let json: string;
  try {
    // `?? "null"` for the same reason `_state-sync.ts` writes `?? null`:
    // `JSON.stringify(undefined)` is `undefined`, not a string.
    json = JSON.stringify(entry.values.get(key)) ?? "null";
  } catch (err: unknown) {
    // Unreachable through `write`, which walks the value first — kept because a
    // throw here would otherwise escape into a tool call's `finally` and replace
    // the tool's own result.
    logger?.error?.("Session state could not be serialized", {
      sessionId,
      slot: key,
      error: errorMessage(err),
    });
    return undefined;
  }
  // Write only what CHANGED. The draft model hands us a new object on every
  // mutation, so identity says nothing and the serialization is the comparison —
  // which is the answer to retail's ~106 KB of state being touched on nearly
  // every tool call.
  if (json === entry.committed.get(key)) return undefined;
  // BYTES, never `String.length` — the same rule `_fetch-capped.ts` states, and
  // the same bug this had. `length` counts UTF-16 code units, so a slot holding
  // CJK or emoji passed the cap at up to ~3x its real size: `{"blob":"あ"×1048570}`
  // is 1,048,581 units and 3,145,721 bytes, i.e. under a 1 MiB cap while writing
  // 3 MiB into the tenant's schema. It mattered more here than for a transient
  // HTTP read, because bounding what `appDatabaseUsage` shows an author as THEIR
  // own usage is the cap's whole job — and the log said `bytes` of a number that
  // was not one.
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_SESSION_STATE_BYTES) {
    // A durability failure, reported, rather than a correctness one: the model
    // already has its result and the in-memory value is right. The cap is what
    // stops one runaway slot filling the tenant's own schema — which the studio
    // shows as THEIR database usage.
    //
    // Note what the refusal LEAVES: a previously committed, smaller value stays
    // in the backend, so a resume hydrates a stale value rather than none. That
    // is the better of the two — the alternative is discarding what the caller
    // last had — but it is a different failure from "absent", and a reader of
    // the log line above should know which one they have.
    logger?.error?.("Session state too large to store", {
      sessionId,
      slot: key,
      bytes,
      cap: MAX_SESSION_STATE_BYTES,
    });
    return undefined;
  }
  return json;
}

/**
 * The commit round trip, and what happens when it fails.
 *
 * Never rethrows: this runs in a tool call's `finally`, and a storage fault must
 * not become the tool's result. The slots go back on the dirty set so the next
 * tool call retries — the value is still correct in memory, so what a failure
 * costs is durability until then, which is the memory tier's behaviour for as
 * long as it lasts.
 */
async function commitPending(
  backend: SessionStateBackend,
  entry: SessionEntry,
  pending: ReadonlyMap<string, string>,
  sessionId: string,
  logger: Logger | undefined,
): Promise<void> {
  try {
    await backend.commit(sessionId, pending);
    for (const [key, json] of pending) entry.committed.set(key, json);
  } catch (err: unknown) {
    for (const key of pending.keys()) entry.dirty.add(key);
    logger?.warn?.("Session state not stored", { sessionId, error: errorMessage(err) });
  }
}

/**
 * Build the store over one backend.
 *
 * ## Shape drift is FAIL-OPEN, and it is specific to redeploy
 *
 * A crash brings back the same code; a redeploy brings back NEW code, and a
 * redeploy is exactly when a slot's shape is most likely to have changed. So a
 * value written by the previous version of an agent is read by the next one,
 * mid-call, for live callers. A stored value that will not parse, or a slot the
 * running code no longer declares, is therefore DISCARDED with a warning rather
 * than refused: refusing would mean a routine deploy drops every in-flight call,
 * which is an outage in exchange for avoiding a forgotten cart. eve reaches the
 * same rule for the same reason (`context/serialize.ts`).
 *
 * So: **persistence is reliable across crashes and best-effort across
 * redeploys.** Anything stronger needs versioned slot schemas with
 * author-written migrations, which is a much larger feature — and a slot
 * deliberately declares no `version`, because under fail-open a wrong guess
 * costs one session's state rather than correctness.
 *
 * @internal
 */
export function createSessionStateStore(opts: {
  backend: SessionStateBackend;
  logger?: Logger | undefined;
}): SessionStateStore {
  const { backend, logger } = opts;
  const sessions = new Map<string, SessionEntry>();

  const entryFor = (sessionId: string): SessionEntry =>
    getOrCreate(sessions, sessionId, () => ({
      values: new Map(),
      dirty: new Set(),
      committed: new Map(),
    }));

  return {
    backend,
    viewFor(sessionId) {
      return {
        read: (key) => sessions.get(sessionId)?.values.get(key),
        write: (key, value, durable) => {
          const entry = entryFor(sessionId);
          // A VIRTUAL slot's value is cached and nothing else: not checked, not
          // frozen, and never marked dirty — which is the whole of "never
          // committed", since `flush` reads the dirty set and nothing else.
          entry.values.set(key, durable ? freezeStorable(value, key) : value);
          // Checked and frozen HERE rather than at the backend, so a value a
          // database cannot hold fails the same way with no database at all.
          if (durable) entry.dirty.add(key);
        },
      };
    },
    syncSession(sessionId) {
      return {
        read: (key) => sessions.get(sessionId)?.values.get(key),
        lastPush: () => sessions.get(sessionId)?.lastPush,
        recordPush: (json) => {
          entryFor(sessionId).lastPush = json;
        },
      };
    },
    // Counts a VIRTUAL slot's write too, and that is right rather than an
    // oversight worth chasing. `pushStateSnapshot` is the caller, and what it
    // asks is "has this session anything to SHOW a reconnecting client" — which a
    // `syncState` projection answers from `values`, where a virtual slot's value
    // also lives. Narrowing this to durable slots would leave a session whose
    // only state is virtual rendering empty on a resume, which is the very bug
    // that call exists to prevent. It is deliberately NOT "has anything to
    // COMMIT": `flush` reads the dirty set, and nothing else.
    has: (sessionId) => (sessions.get(sessionId)?.values.size ?? 0) > 0,
    async hydrate(sessionId) {
      const stored = await backend.load(sessionId);
      if (stored.size === 0) return;
      const entry = entryFor(sessionId);
      for (const [key, json] of stored) hydrateOne(entry, key, json, sessionId, logger);
    },
    async flush(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.dirty.size === 0) return;
      const pending = new Map<string, string>();
      for (const key of entry.dirty) {
        const json = serializeForCommit(entry, key, sessionId, logger);
        if (json !== undefined) pending.set(key, json);
      }
      // Cleared BEFORE the await: a mutation landing during the commit must stay
      // dirty, and clearing after would drop it.
      entry.dirty.clear();
      if (pending.size > 0) await commitPending(backend, entry, pending, sessionId, logger);
    },
    discard(sessionId) {
      sessions.delete(sessionId);
      // Fire-and-forget, and correct: the caller is a grace-window sweep with
      // nothing to report to and nobody waiting. A row left behind is reclaimed
      // by the platform's TTL sweep (`aai-server/pg-cron.ts`).
      void backend.discard(sessionId).catch((err: unknown) => {
        logger?.warn?.("Session state not reclaimed", { sessionId, error: errorMessage(err) });
      });
    },
    clear() {
      sessions.clear();
    },
  };
}
