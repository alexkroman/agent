// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:session-state` epoch 1.
 *
 * A host implementing `SessionStateBackend` itself — which is what this capability
 * is for. Written the way it was authored at epoch 1, when `name` was
 * `"memory" | "postgres"`, and it must keep compiling for as long as that epoch is
 * advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Epoch 2 widened `name` to include `"platform"` — session state on the platform's
 * own database, over HTTP. Widening the union of a field an implementor SUPPLIES is
 * not breaking: `name: "postgres"` below still satisfies the wider type, which is
 * what makes this a retain rather than a drop.
 *
 * The direction that WOULD break is a consumer switching exhaustively on `name`.
 * That is not what this capability is authored against — a host implements the
 * backend, it does not enumerate the platform's own tiers — so the promise holds.
 *
 * Editing this file to make a future error go away defeats the mechanism: the error
 * IS the finding, and it means epoch 1 has to be dropped with a reason.
 */

import type { SessionStateBackend, StoredSessionEvent } from "../../../runtime-barrel.ts";

/**
 * A host's own backend, over whatever store it has.
 *
 * Deliberately in-memory here so the example compiles with no dependencies. The
 * SHAPE is the promise, not the storage.
 */
export function createExampleBackend(): SessionStateBackend {
  const slots = new Map<string, Map<string, string>>();
  const events = new Map<string, StoredSessionEvent[]>();

  return {
    name: "postgres",
    durable: true,

    async load(sessionId) {
      return new Map(slots.get(sessionId) ?? []);
    },

    async commit(sessionId, values) {
      const existing = slots.get(sessionId) ?? new Map<string, string>();
      for (const [slot, value] of values) existing.set(slot, value);
      slots.set(sessionId, existing);
    },

    async discard(sessionId) {
      slots.delete(sessionId);
      events.delete(sessionId);
    },

    async appendEvents(sessionId, incoming) {
      const log = events.get(sessionId) ?? [];
      for (const event of incoming) {
        // Appending an index already stored is a NO-OP, which is what makes a
        // retried flush safe.
        if (!log.some((stored) => stored.index === event.index)) log.push(event);
      }
      log.sort((a, b) => a.index - b.index);
      events.set(sessionId, log);
    },

    async readEvents(sessionId, startIndex, limit) {
      return (events.get(sessionId) ?? [])
        .filter((event) => event.index >= startIndex)
        .slice(0, limit);
    },

    async countEvents(sessionId) {
      // ONE PAST THE HIGHEST, never a count: the log may have holes, and a count
      // would hand a resumed session an index it has already used.
      const log = events.get(sessionId) ?? [];
      return log.reduce((highest, event) => Math.max(highest, event.index + 1), 0);
    },
  };
}
