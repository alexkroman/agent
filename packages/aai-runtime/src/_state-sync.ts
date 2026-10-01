// Copyright 2026 the AAI authors. MIT license.
/**
 * Deciding what — if anything — to push to the client after a tool call,
 * for `AgentDef.syncState`.
 *
 * Its own module because the decision has four failure modes worth testing
 * directly, and reaching them through `createRuntime` would need a whole
 * transport and session.
 *
 * The last-sent record is held BY THE CALLER (`host/session-state-store.ts` keeps
 * it beside the session's slot values), which is a change worth its own note. It
 * used to be a `WeakMap` keyed by the state OBJECT, so that the record was
 * collected along with the state and there was no sweep to forget. There is no
 * single state object any more — a session's slots are separate values — and the
 * store already reclaims per session, so keeping it there is one lifetime rather
 * than two. It also removes the sharp edge that arrangement had: a resumed
 * session inherited the same state object and therefore the same record, so a
 * push aimed at the superseded socket counted as delivered to the new client
 * (which is why `force` exists, and still does).
 */

import type { StateProjection } from "@alexkroman1/aai";
import { MAX_CLIENT_EVENT_PAYLOAD_BYTES } from "@alexkroman1/aai/internal";
import { errorMessage } from "@alexkroman1/aai/utils";

/** Why nothing was pushed, when nothing was. */
export type StateSyncSkip =
  | { push: false; reason: "unchanged" }
  | { push: false; reason: "failed"; detail: string }
  | { push: false; reason: "too-large"; bytes: number };

export type StateSyncResult = { push: true; state: Record<string, unknown> } | StateSyncSkip;

export type StateSyncOptions = {
  /**
   * Send even when the projection is unchanged.
   *
   * For a RESUMED session: the values are the ones the previous socket's client
   * was shown, so the last-sent record still matches and the ordinary path would
   * correctly report "unchanged" — but the client on the other end is new and
   * has seen nothing. Staleness is a property of the client, not of the state,
   * and only the caller knows a client just arrived.
   */
  force?: boolean;
};

/** The per-session state this decision reads and writes. */
export type StateSyncSession = {
  /** One slot's current value, or `undefined` if the session never touched it. */
  read(key: string): unknown;
  /** The serialization last pushed to this session, if any. */
  lastPush(): string | undefined;
  /** Record what was just pushed. */
  recordPush(json: string): void;
};

export type StateSync = (session: StateSyncSession, options?: StateSyncOptions) => StateSyncResult;

/**
 * Build the per-runtime sync decision for an agent's `syncState` projections.
 *
 * The frame is KEYED by slot name — `{ [slot]: view }` — however many slots
 * the agent projects, so a projection may return any JSON value and the client
 * selects its slot by the same name (`useAgentState(slot.projected)`). There
 * is no single-projection special case and no merge: one shape on the wire.
 *
 * Comparison is on the SERIALIZED frame, which is the same string the frame
 * would carry — the point is to avoid writing bytes that are already on the
 * client, and this socket also carries 384 kbps of PCM.
 */
export function createStateSync(projections: readonly StateProjection[]): StateSync {
  return (session, options) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(project(projections, session));
    } catch (err) {
      // A projection that throws, or returns a cycle or a BigInt, is the
      // author's bug — but it must not take the tool call down with it.
      return { push: false, reason: "failed", detail: errorMessage(err) };
    }
    if (!options?.force && serialized === session.lastPush()) {
      return { push: false, reason: "unchanged" };
    }
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_CLIENT_EVENT_PAYLOAD_BYTES) return { push: false, reason: "too-large", bytes };
    session.recordPush(serialized);
    // Re-parsed rather than passing the projection's return value: the frame
    // must carry exactly what was measured and compared, with anything
    // JSON drops (undefined fields, functions) already dropped.
    return { push: true, state: JSON.parse(serialized) as Record<string, unknown> };
  };
}

/**
 * Read each slot and project it under its own name. Throws like any projection.
 * `?? null` so a projection returning undefined is still a key the client sees,
 * rather than one `JSON.stringify` silently drops.
 */
function project(
  projections: readonly StateProjection[],
  session: StateSyncSession,
): Record<string, unknown> {
  const frame: Record<string, unknown> = {};
  for (const projection of projections) {
    frame[projection.key] = projection(session.read(projection.key)) ?? null;
  }
  return frame;
}
