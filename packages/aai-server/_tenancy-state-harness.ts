// Copyright 2026 the AAI authors. MIT license.
/**
 * The reference semantics for the two NON-journal stores: `platform-uploads.ts`
 * and `platform-session-state.ts`.
 *
 * Cut here rather than at a line count, because this is the seam the code under
 * test already has — three modules, three subjects, and the journal is much the
 * largest. Each case below states the statement it mirrors, because a mistake
 * here surfaces as a divergence in the property, and a divergence has to be
 * readable as "the model is wrong about this statement" rather than as a leak.
 *
 * Every function takes ONE tenant's bucket. That is the whole tenancy argument
 * of the reference world: a cross-tenant read is not merely absent, it is
 * unrepresentable, because there is no second bucket in scope. The deliberate
 * exception is `discardSession`, which takes its event targets as a parameter so
 * the leak variant can hand it more than one.
 */

import type { Answer, Op } from "./_tenancy-ops-harness.ts";

export type Upload = {
  id: string;
  name: string;
  type: string;
  size: number;
  complete: boolean;
  expected: number | undefined;
  parts: { at: number; bytes: number }[];
};

export type SlotRow = { sessionId: string; slot: string; value: string };
export type EventRow = { sessionId: string; index: number; event: string };

/** The three tables these two stores own, inside one tenant's bucket. */
export type StateTables = {
  uploads: Map<string, Upload>;
  slots: Map<string, SlotRow>;
  events: Map<string, EventRow>;
};

/** `|` appears in no generated identifier, so a composite key cannot be ambiguous. */
export const pair = (a: string, b: string | number): string => `${a}|${b}`;

export type UploadOp = Extract<
  Op,
  { t: "claimUpload" | "insertUpload" | "updateUpload" | "finishUpload" | "readUpload" }
>;

export type SessionOp = Extract<
  Op,
  {
    t:
      | "commitSlots"
      | "loadSlots"
      | "appendEvents"
      | "readEvents"
      | "nextEventIndex"
      | "discardSession";
  }
>;

/** Rows of one session, in insertion order; the callers that care re-sort. */
const rowsOf = <T extends { sessionId: string }>(rows: Iterable<T>, sessionId: string): T[] =>
  [...rows].filter((row) => row.sessionId === sessionId);

/** Every row of one session, gone. Extracted so the case bodies stay flat. */
function dropSession<T extends { sessionId: string }>(
  table: Map<string, T>,
  sessionId: string,
): void {
  for (const [key, row] of table) if (row.sessionId === sessionId) table.delete(key);
}

/** `platform-uploads.ts`'s five methods, over one tenant's uploads. */
export function applyUploadOp(t: StateTables, op: UploadOp): Answer {
  const upload = "id" in op ? t.uploads.get(op.id) : undefined;
  switch (op.t) {
    case "claimUpload":
      // `on conflict (slug, id) do nothing` plus a returning-row check: the
      // insert IS the claim, and a taken id is refused even for an identical
      // declaration, which is what makes a caller-chosen id safe.
      if (upload) return { refused: "upload-taken" };
      t.uploads.set(op.id, {
        id: op.id,
        name: op.name,
        type: "audio/wav",
        size: 0,
        complete: false,
        expected: op.expected,
        parts: [],
      });
      return { ok: undefined };
    case "insertUpload":
      // An upsert, so a retried request is idempotent; this id was minted by the
      // store and cannot collide, so "taken" is not a reachable failure.
      t.uploads.set(op.id, {
        id: op.id,
        name: op.name,
        type: "text/plain",
        size: op.size,
        complete: true,
        expected: undefined,
        parts: [{ at: 0, bytes: op.size }],
      });
      return { ok: undefined };
    case "updateUpload": {
      // Only the three columns a window arrival can change — `name`, `type` and
      // `expected` are the declaration's and are never rewritten by a write.
      if (upload) {
        upload.size = op.size;
        upload.complete = op.complete;
        upload.parts = [{ at: 0, bytes: op.size }];
      }
      return { ok: undefined };
    }
    case "finishUpload": {
      // Not an update with `complete: true`: `parts` must be left exactly as it
      // is, every window having already joined the list.
      if (upload) {
        upload.size = op.size;
        upload.complete = true;
      }
      return { ok: undefined };
    }
    case "readUpload": {
      if (!upload) return { ok: undefined };
      const { id: _id, ...record } = upload;
      return { ok: { ...record, parts: [...record.parts] } };
    }
    default:
      throw new Error("tenancy reference reached an upload op it does not model");
  }
}

/**
 * `platform-session-state.ts`'s six methods, over one tenant's session rows.
 *
 * @param eventTargets - the buckets `discardSession` deletes EVENTS from. One
 *   (this tenant's) for the reference; the leak variant passes more, which is
 *   the `session-discard` predicate being dropped from the CTE's second delete.
 */
export function applySessionOp(
  t: StateTables,
  op: SessionOp,
  eventTargets: readonly StateTables[],
): Answer {
  switch (op.t) {
    case "commitSlots":
      // One `unnest` upsert; an empty map is a no-op rather than a statement.
      for (const [slot, value] of Object.entries(op.values)) {
        t.slots.set(pair(op.sessionId, slot), { sessionId: op.sessionId, slot, value });
      }
      return { ok: undefined };
    case "loadSlots":
      return {
        ok: Object.fromEntries(
          rowsOf(t.slots.values(), op.sessionId).map((row) => [row.slot, row.value]),
        ),
      };
    case "appendEvents":
      // `on conflict … do nothing`, which is what makes a retried flush
      // idempotent: the index is assigned above the backend, so a re-append of a
      // stored index has to be a no-op rather than an error.
      for (const event of op.events) {
        const key = pair(op.sessionId, event.index);
        if (t.events.has(key)) continue;
        t.events.set(key, { sessionId: op.sessionId, index: event.index, event: event.event });
      }
      return { ok: undefined };
    case "readEvents":
      return {
        ok: rowsOf(t.events.values(), op.sessionId)
          .filter((row) => row.index >= op.startIndex)
          .sort((x, y) => x.index - y.index)
          .slice(0, op.limit)
          .map((row) => ({ index: row.index, event: row.event })),
      };
    case "nextEventIndex":
      // `coalesce(max(event_index), -1) + 1` — one past the HIGHEST stored, never
      // a count. Under a count a resumed session's tail goes BACKWARDS and its
      // re-used appends are silently dropped by the `on conflict` above.
      return {
        ok: Math.max(-1, ...rowsOf(t.events.values(), op.sessionId).map((row) => row.index)) + 1,
      };
    case "discardSession":
      // BOTH tables, as one CTE. Here the tenant holds no credential on this
      // database at all, so the append-only property is structural and `discard`
      // can do what it says.
      dropSession(t.slots, op.sessionId);
      for (const target of eventTargets) dropSession(target.events, op.sessionId);
      return { ok: undefined };
    default:
      throw new Error("tenancy reference reached a session op it does not model");
  }
}
