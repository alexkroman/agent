// Copyright 2026 the AAI authors. MIT license.
/**
 * The REFERENCE {@link SessionStateBackend}: what a deployment with no database
 * gets, and the double the other two are measured against.
 *
 * It really stores — a session's values survive its own disconnect and the
 * resume grace window, which is what the runtime's old `stateMap` did — and it
 * really cannot survive the process, which is the difference the two tiers exist
 * to express. Values are held as the same serialized JSON the Postgres backend
 * holds, so the round trip a value takes is identical in both.
 *
 * ## Why it is its own module now
 *
 * It was declared in `session-state-store.ts`, beside the interface and the
 * cache above it, and two things moved it out:
 *
 * - **It is the reference arm of a conformance table**
 *   (`session-state-conformance.ts`), and the table's registry discovers a
 *   backend by its FACTORY NAME. A `session-state-<backend>.ts` per backend is
 *   what makes that grammar uniform — `konsistent.json`'s
 *   `session-state-backends` convention pins it — where "memory lives in the
 *   store module and the other two do not" is the asymmetry a fourth backend
 *   copies by accident.
 * - **The store module was at 499 lines against a 500-line cap**, so the
 *   one-line fix its `appendEvents` owed (below) could not be written with its
 *   reason beside it.
 *
 * `session-state-store.ts` re-exports the factory, so every existing importer
 * still takes it from the module that declares the interface.
 */

import type { SessionStateBackend, StoredSessionEvent } from "./session-state-store.ts";

/**
 * Session state in this process's heap.
 *
 * @internal
 */
export function createMemoryStateBackend(): SessionStateBackend {
  const sessions = new Map<string, Map<string, string>>();
  /** One session's event log, keyed by index — sparse-tolerant, like the rows. */
  const events = new Map<string, Map<number, string>>();
  return {
    name: "memory",
    durable: false,
    load: (sessionId) => Promise.resolve(new Map(sessions.get(sessionId) ?? [])),
    commit: (sessionId, values) => {
      // MERGES rather than replaces, because the store above sends only the
      // slots that CHANGED — a replace would drop every slot a tool call did
      // not touch. Both databases reach the same behaviour through
      // `on conflict … do update`.
      const session = sessions.get(sessionId) ?? new Map<string, string>();
      for (const [key, json] of values) session.set(key, json);
      sessions.set(sessionId, session);
      return Promise.resolve();
    },
    discard: (sessionId) => {
      sessions.delete(sessionId);
      // Events too, which is now the CONTRACT rather than this backend's own
      // choice. The Postgres one deliberately dropped slots only, under an
      // interface that hedged ("not always both"), so the shared conformance
      // table asserted nothing about the log and three implementations gave two
      // answers. Decided the other way: `discard` reclaims both everywhere, and
      // two shared cases now assert it on every arm — see "`discard` reclaims
      // BOTH" in `session-state-conformance.ts`.
      events.delete(sessionId);
      return Promise.resolve();
    },
    appendEvents: (sessionId, pending) => {
      const log = events.get(sessionId) ?? new Map<number, string>();
      for (const event of pending) {
        // FIRST write wins, and this guard is the whole difference between a
        // no-op and an upsert. The interface promises that "appending an index
        // that is already stored is a no-op"; both databases deliver that with
        // `on conflict (…, event_index) do nothing`, which KEEPS the stored
        // row. A bare `log.set` replaced it instead, so the one backend every
        // other spec uses as its double answered a retried flush differently
        // from the two that run in production — and a retried flush is exactly
        // when the two answers diverge, because a partial failure is what makes
        // the second append happen at all. Found by the conformance table.
        if (!log.has(event.index)) log.set(event.index, event.json);
      }
      events.set(sessionId, log);
      return Promise.resolve();
    },
    readEvents: (sessionId, startIndex, limit) => {
      const log = events.get(sessionId);
      if (!log) return Promise.resolve([]);
      const out: StoredSessionEvent[] = [];
      // By index rather than by insertion order: the Postgres backend answers
      // `order by index`, and a memory backend that answered otherwise would
      // stop being a valid test double for it.
      for (const index of [...log.keys()].sort((a, b) => a - b)) {
        if (index < startIndex) continue;
        if (out.length >= limit) break;
        const json = log.get(index);
        if (json !== undefined) out.push({ index, json });
      }
      return Promise.resolve(out);
    },
    countEvents: (sessionId) => {
      // `max + 1`, not `size` — see the backend type's doc. A sparse log (the
      // retention cap, a partly-failed flush) is exactly where the two differ,
      // and it is the case this answer exists for.
      const log = events.get(sessionId);
      let highest = -1;
      // A loop rather than `Math.max(...keys)`: the log holds up to
      // `MAX_SESSION_EVENTS` entries and spreading that many arguments is a
      // stack overflow waiting for the cap to be raised.
      for (const index of log?.keys() ?? []) if (index > highest) highest = index;
      return Promise.resolve(highest + 1);
    },
  };
}
