// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 TEMPLATE: `aai-runtime:session-state` — a custom state backend.
 *
 * This is the starter as it was written at epoch 1: a {@link
 * SessionStateBackend} over a key-value store, plus the lifecycle a host drives
 * through the {@link SessionStateStore} in front of it. Copy the file into your
 * host, point {@link KeyValueStore} at what you already run — Redis, a bucket,
 * a document database, a table of your own — and the runtime's slots and session
 * event log live there.
 *
 * **FROZEN.** This file must keep compiling against current source for as long
 * as epoch 1 is supported — a compile error here is the finding, not something
 * to edit away. The way to change this API is a NEW epoch carrying a new
 * template, never an edit to this one. (Imports are relative because the
 * package cannot resolve itself by name; in your copy they are
 * `@alexkroman1/aai-runtime`.)
 *
 * **What to change:** {@link KeyValueStore} and its three operations, the key
 * layout, and the tier `name` the backend reports.
 *
 * **What not to change — the four obligations.** Each is a silent corruption
 * rather than a failure if you get it wrong:
 *
 * - **Values cross this boundary as SERIALIZED JSON.** The cache above the
 *   backend holds objects; a backend that took objects could not be told apart
 *   from that cache when the encoding is what breaks.
 * - **`countEvents` returns one past the HIGHEST stored index, never a count.**
 *   The log need not be dense — a capped event advances the position without
 *   being stored, and a partly-failed flush leaves a hole — so under a count a
 *   session resuming onto a replacement process is handed an index it has
 *   already used, its cursor goes backwards, and the re-used appends are
 *   dropped.
 * - **`appendEvents` is IDEMPOTENT at an index.** Indices are assigned above
 *   the backend, synchronously, so never invent one, and never let a retried
 *   flush be the thing that breaks a call.
 * - **`commit` receives only the slots that CHANGED, and is awaited at the end
 *   of a tool call.** It is on a turn's critical path: one round trip per
 *   changed slot is the budget.
 */

import type {
  SessionStateBackend,
  SessionStateStore,
  StoredSessionEvent,
} from "../../../runtime-barrel.ts";

// ---------------------------------------------------------------------------
// Edit point: your store
// ---------------------------------------------------------------------------

/**
 * ← Whatever you already run. Everything below is written against these three
 * operations and nothing else, so this is the only part to replace.
 */
export type KeyValueStore = {
  put(key: string, value: string): Promise<void>;
  /** Every key/value under a prefix. Order is not relied on — see `storedEvents`. */
  list(prefix: string): Promise<readonly { readonly key: string; readonly value: string }[]>;
  dropPrefix(prefix: string): Promise<void>;
};

/** ← the key layout. Both prefixes must be listable and droppable per session. */
const slotPrefix = (sessionId: string): string => `slots/${sessionId}/`;
const eventPrefix = (sessionId: string): string => `events/${sessionId}/`;

/**
 * ← the tier this backend claims. A closed union of the two the SDK ships, so
 * claim the one you BEHAVE like: `"postgres"` for state that survives the
 * process (as here), `"memory"` for state that does not. It is what an operator
 * reads in the resolved-mode log line, which is the only place "is this agent's
 * state durable" is answerable from outside the process.
 */
const TIER: SessionStateBackend["name"] = "postgres";

// ---------------------------------------------------------------------------
// Reading the event log back
// ---------------------------------------------------------------------------

/** The index a key encodes, or null for a key that is not one of ours. */
function indexOf(key: string, prefix: string): number | null {
  const tail = key.slice(prefix.length);
  const index = Number(tail);
  return tail !== "" && Number.isSafeInteger(index) && index >= 0 ? index : null;
}

/** This session's stored events, in index order — what both readers need. */
async function storedEvents(kv: KeyValueStore, sessionId: string): Promise<StoredSessionEvent[]> {
  const prefix = eventPrefix(sessionId);
  const rows = await kv.list(prefix);
  const events: StoredSessionEvent[] = [];
  for (const row of rows) {
    const index = indexOf(row.key, prefix);
    if (index !== null) events.push({ index, json: row.value });
  }
  // Sort here rather than trusting `list`: the shipped Postgres backend answers
  // `order by index`, and a backend that answered otherwise would stop being
  // interchangeable with it.
  return events.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

/** A state backend over your own store. */
export function createKvStateBackend(kv: KeyValueStore): SessionStateBackend {
  return {
    name: TIER,
    durable: true, // ← false if your store does not survive the process

    load: async (sessionId) => {
      const prefix = slotPrefix(sessionId);
      const values = new Map<string, string>();
      for (const row of await kv.list(prefix)) values.set(row.key.slice(prefix.length), row.value);
      return values;
    },

    commit: async (sessionId, values) => {
      // Only the changed slots arrive, and this is awaited inside a tool call:
      // one write per slot, not one per mutation.
      for (const [slot, json] of values) await kv.put(`${slotPrefix(sessionId)}${slot}`, json);
    },

    discard: async (sessionId) => {
      // This backend owns both, so it may reclaim both. If your event log is
      // append-only to the role this process holds, drop the slots only and
      // leave the events to a retention sweep.
      await kv.dropPrefix(slotPrefix(sessionId));
      await kv.dropPrefix(eventPrefix(sessionId));
    },

    appendEvents: async (sessionId, events) => {
      // Keyed BY the index the event already carries, which is what makes a
      // retried append a no-op instead of a duplicate.
      for (const event of events) {
        await kv.put(`${eventPrefix(sessionId)}${event.index}`, event.json);
      }
    },

    readEvents: async (sessionId, startIndex, limit) => {
      const events = await storedEvents(kv, sessionId);
      return events.filter((event) => event.index >= startIndex).slice(0, limit);
    },

    countEvents: async (sessionId) => {
      let highest = -1;
      for (const event of await storedEvents(kv, sessionId)) {
        if (event.index > highest) highest = event.index;
      }
      // `max + 1`, NOT `rows.length`. A sparse log is exactly where the two
      // differ, and it is the case this answer exists for.
      return highest + 1;
    },
  };
}

// ---------------------------------------------------------------------------
// The lifecycle a host drives
// ---------------------------------------------------------------------------

/** The four moments a host has to handle, over the store it was handed. */
export type SessionStateLifecycle = {
  /** Session start. Resolves the slot's stored value, or undefined. */
  resume(sessionId: string, slot: string): Promise<unknown>;
  /** Whenever a projection may have moved. Returns whether a frame went out. */
  push(
    sessionId: string,
    render: (read: (key: string) => unknown) => unknown,
    send: (json: string) => void,
  ): boolean;
  /** End of the resume grace window. */
  retire(sessionId: string): Promise<void>;
  /** Process shutdown. */
  shutdown(): void;
  /** The tier line to print at boot. */
  tier(): string;
};

export function createSessionStateLifecycle(store: SessionStateStore): SessionStateLifecycle {
  return {
    // `hydrate` is paid only on a resume — a fresh session has nothing stored
    // and the backend answers empty — and it belongs INSIDE the session-start
    // window, because `read` is synchronous and there is no first-tool-call
    // await to hang a load off. A rejection here fails the session start; shape
    // drift is not a rejection, so a slot whose shape moved under a redeploy is
    // dropped with a warning and reads back as undefined.
    resume: async (sessionId, slot) => {
      await store.hydrate(sessionId);
      if (!store.has(sessionId)) return;
      return store.viewFor(sessionId).read(slot);
    },

    // Render, compare, send only on a difference — `lastPush` is what makes an
    // unchanged projection cost nothing on the wire.
    push: (sessionId, render, send) => {
      const session = store.syncSession(sessionId);
      const json = JSON.stringify(render((key) => session.read(key)));
      if (json === session.lastPush()) return false;
      session.recordPush(json);
      send(json);
      return true;
    },

    // Commit what this session changed, then reclaim it. `flush` never rejects
    // — a failed commit costs durability, not correctness — and `discard`
    // reclaims the cache entry AND the stored rows, which is why this belongs
    // at the end of the resume grace window rather than at disconnect.
    retire: async (sessionId) => {
      if (!store.has(sessionId)) return;
      await store.flush(sessionId);
      store.discard(sessionId);
    },

    // Drop every cache entry and leave the STORED rows alone. The distinction
    // from `discard` is why both exist: a process going away must not reclaim
    // state a replacement process is about to hydrate.
    shutdown: () => store.clear(),

    tier: () => `${store.backend.name} (${store.backend.durable ? "durable" : "process-local"})`,
  };
}
