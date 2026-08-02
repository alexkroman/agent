// Copyright 2026 the AAI authors. MIT license.
/**
 * Deciding what — if anything — to push to the client after a tool call,
 * for `AgentDef.syncState`.
 *
 * Its own module because the decision has three failure modes worth testing
 * directly, and reaching them through `createRuntime` would need a whole
 * transport and session.
 *
 * Keyed by the state OBJECT in a `WeakMap`, not by session id: the last-sent
 * record is then collected along with the session's state, so there is no
 * sweep to forget and no way for a long-lived server to accumulate one entry
 * per session that ever ran.
 */

import { MAX_CLIENT_EVENT_PAYLOAD_BYTES } from "../sdk/constants.ts";
import { errorMessage } from "../sdk/utils.ts";

/** Why nothing was pushed, when nothing was. */
export type StateSyncSkip =
  | { push: false; reason: "unchanged" }
  | { push: false; reason: "failed"; detail: string }
  | { push: false; reason: "too-large"; bytes: number };

export type StateSyncResult = { push: true; state: unknown } | StateSyncSkip;

export type StateSync = (state: object) => StateSyncResult;

/**
 * Build the per-runtime sync decision for one `syncState` projection.
 *
 * Comparison is on the SERIALIZED projection, which is the same string the
 * frame would carry — the point is to avoid writing bytes that are already on
 * the client, and this socket also carries 384 kbps of PCM.
 */
export function createStateSync(project: (state: never) => unknown): StateSync {
  const lastSent = new WeakMap<object, string>();
  return (state) => {
    let serialized: string;
    try {
      // `?? null` so a projection returning undefined is a valid, comparable
      // value rather than `JSON.stringify` handing back undefined.
      serialized = JSON.stringify((project as (s: object) => unknown)(state) ?? null);
    } catch (err) {
      // A projection that throws, or returns a cycle or a BigInt, is the
      // author's bug — but it must not take the tool call down with it.
      return { push: false, reason: "failed", detail: errorMessage(err) };
    }
    if (serialized === lastSent.get(state)) return { push: false, reason: "unchanged" };
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_CLIENT_EVENT_PAYLOAD_BYTES) return { push: false, reason: "too-large", bytes };
    lastSent.set(state, serialized);
    // Re-parsed rather than passing the projection's return value: the frame
    // must carry exactly what was measured and compared, with anything
    // JSON drops (undefined fields, functions) already dropped.
    return { push: true, state: JSON.parse(serialized) };
  };
}
