// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:session-state` epoch 1.
 *
 * **"Frozen" means this file must keep compiling against current source for as
 * long as epoch 1 is advertised as supported.** A compile error here is the
 * finding, not something to edit away — `pnpm typecheck` is the
 * backward-compatibility gate for this capability. Imports are RELATIVE
 * (`../../../runtime-barrel.ts`) because the package cannot resolve itself by
 * name.
 *
 * Where a session's slots live between turns. The capability is two types, and
 * the interesting one is the interface: `SessionStateBackend` is what a host
 * with its own durable tier implements, so this file implements one — over a
 * key-value store, which is the shape most hosts already have — and then uses
 * the `SessionStateStore` in front of it the way a session's lifecycle does.
 *
 * Four obligations the interface states and this implementation keeps, each of
 * which is a silent corruption if it is got wrong rather than a failure:
 *
 * - **Values cross this boundary as SERIALIZED JSON.** The cache above the
 *   backend holds objects; a backend that took objects could not be told apart
 *   from that cache when the encoding is what breaks.
 * - **`countEvents` is one past the HIGHEST stored index, never a count.** The
 *   log need not be dense — a capped event advances the position without being
 *   stored, and a partly-failed flush leaves a hole — so under a count a session
 *   resuming onto a replacement process is handed an index it has already used,
 *   its cursor goes backwards, and the re-used appends are dropped.
 * - **`appendEvents` is IDEMPOTENT at an index.** Indices are assigned above
 *   the backend, synchronously, so a backend never invents one, and a retried
 *   flush must not be the thing that breaks a call.
 * - **`commit` is called with only the slots that changed**, and awaited at the
 *   end of the tool call — so a write here is on a turn's critical path and one
 *   round trip per changed slot is the budget.
 */

import type {
  SessionStateBackend,
  SessionStateStore,
  StoredSessionEvent,
} from "../../../runtime-barrel.ts";

/**
 * The host's own store, standing in for whatever it already runs — Redis, a
 * bucket, a document database. Everything below is written against these four
 * operations and nothing else.
 */
export type KeyValueStore = {
  put(key: string, value: string): Promise<void>;
  /** Every key/value under a prefix. Order is not relied on. */
  list(prefix: string): Promise<readonly { readonly key: string; readonly value: string }[]>;
  dropPrefix(prefix: string): Promise<void>;
};

const slotPrefix = (sessionId: string): string => `slots/${sessionId}/`;
const eventPrefix = (sessionId: string): string => `events/${sessionId}/`;

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
  // Sorted here rather than trusted from `list`: the shipped Postgres backend
  // answers `order by index`, and a backend that answered otherwise would stop
  // being interchangeable with it.
  return events.sort((a, b) => a.index - b.index);
}

/**
 * A third backend, over the host's own key-value store.
 *
 * Note `name` is a closed union of the two tiers the SDK ships, so a backend of
 * one's own claims the tier it BEHAVES like — this one survives the process, so
 * it reports itself as the durable tier. The name is what an operator reads in
 * the resolved-mode log line, which is the only place "is this agent's state
 * durable" is answerable from outside the process.
 */
export function createKvStateBackend(kv: KeyValueStore): SessionStateBackend {
  return {
    name: "postgres",
    durable: true,

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
      // This backend owns both, so it may reclaim both. A backend whose event
      // log is append-only to the role it holds drops slots only and leaves the
      // events to a retention sweep.
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
      // `max + 1`. A sparse log is exactly where this differs from a count, and
      // it is the case the answer exists for.
      return highest + 1;
    },
  };
}

/** The tier line an operator reads at boot. */
export function describeStateTier(store: SessionStateStore): string {
  return `${store.backend.name} (${store.backend.durable ? "durable" : "process-local"})`;
}

/**
 * Picking a session's state up on the way in, and reading one slot back.
 *
 * `hydrate` is paid only on a resume — a fresh session has nothing stored and
 * the backend answers empty — and it belongs INSIDE the session-start window,
 * because `slot.get` is synchronous and there is no first-tool-call await to
 * hang a load off. A rejection here is a failed session start; shape drift is
 * not a rejection, so a slot whose shape moved under a redeploy is dropped with
 * a warning and this returns undefined for it.
 *
 * `has` is what tells a resume from a fresh connection, and `viewFor` is the
 * `SlotStore` a tool's slots read and write through — a host reaches it
 * directly only to inspect, as here.
 */
export async function resumeSessionState(
  store: SessionStateStore,
  sessionId: string,
  slot: string,
): Promise<unknown> {
  await store.hydrate(sessionId);
  if (!store.has(sessionId)) return undefined;
  return store.viewFor(sessionId).read(slot);
}

/**
 * Putting it down on the way out: commit whatever this session changed, then
 * reclaim it.
 *
 * `flush` never rejects — a failed commit costs durability, not correctness, so
 * it is logged rather than thrown — and `discard` reclaims the cache entry and
 * the stored rows together, which is why it is called at the END of the resume
 * grace window and not at disconnect.
 */
export async function retireSessionState(
  store: SessionStateStore,
  sessionId: string,
): Promise<void> {
  if (!store.has(sessionId)) return;
  await store.flush(sessionId);
  store.discard(sessionId);
}

/**
 * The state frame a client is pushed, deduplicated.
 *
 * `syncSession` is the per-session view `syncState` reads and records through,
 * and `lastPush` is what makes an unchanged projection cost nothing on the
 * wire: render, compare, push only on a difference.
 */
export function pushIfChanged(
  store: SessionStateStore,
  sessionId: string,
  render: (read: (key: string) => unknown) => unknown,
  send: (json: string) => void,
): boolean {
  const session = store.syncSession(sessionId);
  const json = JSON.stringify(render((key) => session.read(key)));
  if (json === session.lastPush()) return false;
  session.recordPush(json);
  send(json);
  return true;
}

/**
 * Runtime shutdown: drop every cache entry and leave the STORED rows alone.
 *
 * The distinction from `discard` is the whole reason both exist — a process
 * going away must not reclaim state a replacement process is going to hydrate.
 */
export function releaseAllSessions(store: SessionStateStore): void {
  store.clear();
}
