// Copyright 2026 the AAI authors. MIT license.
/**
 * The third {@link SessionStateBackend}: session slots and the event log over HTTP.
 *
 * A tool's `ctx.slots` and the session event log are committed at the END of every
 * tool call, awaited, so a crash preserves the turn. Both lived in the app's own
 * database — and removing that database with nothing in its place would silently
 * downgrade every agent to memory, where a guest restart mid-conversation loses the
 * turn with `durable: false` in a log line as the only trace.
 *
 * ## A third implementation, not a new design
 *
 * The seam already had two (memory, postgres) and the memory one is only a valid
 * test double for the other because all of them agree. Two agreements are
 * load-bearing and are the reason this file is not a thin wrapper:
 *
 * - **`countEvents` answers `max + 1`, never a count.** The log need not be dense —
 *   an event past the cap advances the position without being stored, and a
 *   partly-failed flush leaves a hole. Under a count a resumed session is handed an
 *   index it has already used, its `tail` goes BACKWARDS, and the re-appended
 *   events are dropped by the platform's `on conflict do nothing`. The platform
 *   computes it; this must not "helpfully" derive it from a length.
 * - **Appending a stored index is a no-op**, because a retried flush after a
 *   partial failure must not be the thing that breaks a call.
 *
 * ## `durable` is TRUE, and it has to be earned
 *
 * The flag drives the "Session mode resolved" line an operator reads, and a backend
 * that claimed durability it does not have is worse than one that admits memory.
 * It is true here because a value committed through this backend is a row in the
 * platform's database, which outlives every sandbox.
 *
 * ## What a failure does, per method
 *
 * The store above this has different tolerances and they are not this module's to
 * invent: `hydrate` REJECTS (the caller turns it into a failed session start,
 * because resuming onto state that did not load would silently drop it), while
 * `flush` never rejects and logs instead. So every method here propagates, and the
 * caller keeps its own policy.
 *
 * **A 501 is not special, and that is the contract.** The platform answers it when
 * the deployment has no platform database at all, and this backend does not
 * downgrade to memory on reading one — `selectBackend` chose it ONCE, from whether
 * the boot env named a platform, so there is nothing per request to re-decide. A
 * 501 therefore fails `hydrate`, i.e. the session start. Silently becoming memory
 * instead would report `durable: true` in the boot line for an agent that is not,
 * which the module doc above calls the worse failure. `aai-server`'s
 * `notConfigured` states the same contract from the other end, and names the one
 * deployment shape where it bites.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { PLATFORM_ROUTES, type PlatformEndpoint } from "./platform-endpoint.ts";
import { platformResult } from "./platform-rpc.ts";
import type { SessionStateBackend, StoredSessionEvent } from "./session-state-store.ts";

/**
 * How long one call may take.
 *
 * A single indexed read or one upsert on the platform's database. Short, because a
 * TOOL CALL is blocked on the commit: the runtime flushes in the same `finally`
 * that pushes `syncState`, awaited, so a hung socket here is a hung turn.
 */
const SESSION_STATE_TIMEOUT_MS = 10_000;

/**
 * What this backend needs to reach the platform.
 *
 * An alias of {@link PlatformEndpoint}: the four platform clients take exactly the
 * same credential pair, which is why one `resolvePlatformQueue()` result is already
 * handed to three of them. The name is kept because it is what the call sites read.
 */
export type PlatformSessionStateOptions = PlatformEndpoint;

/** One call to the platform's session-state route. */
async function call(
  options: PlatformSessionStateOptions,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return await platformResult(options, {
    route: PLATFORM_ROUTES.sessionState,
    label: `session-state ${method}`,
    timeoutMs: SESSION_STATE_TIMEOUT_MS,
    body: JSON.stringify({ method, ...body }),
  });
}

/** A `{slot: value}` map off the wire, ignoring anything that is not a string. */
function toSlotMap(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRecord(value)) return out;
  for (const [slot, stored] of Object.entries(value)) {
    if (typeof stored === "string") out.set(slot, stored);
  }
  return out;
}

/**
 * Stored events off the wire — and an entry this cannot read fails the PAGE.
 *
 * NOT dropped, which is what it used to do and is the same mistake `countEvents`
 * below refuses to make, one step removed. A read of this stream is a CURSOR: a
 * caller takes the page, advances past its highest index, and never asks that
 * range again. So a dropped entry is a HOLE rather than a degraded answer — the
 * event is gone and nothing says so, because a page missing one looks exactly
 * like a page that never held it.
 *
 * `typeof` FIRST, for the reason spelled out at `countEvents`: `Number(null)` is
 * `0` and `Number("")` is `0`, so coercing before checking turns two unreadable
 * answers into a real index. The platform end refuses the identical shapes
 * (`aai-server/platform-session-state.ts`, `readEvents`), so this is a second
 * lock on the same door rather than the only one — the two used to agree by both
 * dropping, and they agree by both refusing now.
 *
 * Unreachable on a healthy read (`event_index` and `event` are `not null`
 * columns), and its one consumer is the read-only session-events surface, so a
 * rejection costs a 500 on a diagnostic read rather than a session.
 */
function toEvents(value: unknown): StoredSessionEvent[] {
  if (!Array.isArray(value)) {
    // "The read did not happen" and "there are no events" are different answers
    // and only one is safe to act on. An empty LOG is a `[]`, which this accepts.
    throw new Error(`session-state readEvents answered ${typeof value}, not a list`);
  }
  return value.map((entry) => {
    // `json`, which is the field name on `StoredSessionEvent` — the serialized
    // `SessionEvent` with its envelope. The wire calls it `event`, matching the
    // platform's column; the two are translated here rather than one being renamed,
    // because the column name is the platform's and the field name is the runtime's.
    if (!isRecord(entry) || typeof entry.event !== "string") {
      throw new Error("session-state readEvents answered an entry with no event");
    }
    const { index } = entry;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      // The index only. The event body is the caller's own data and this message
      // reaches a log line.
      throw new Error(`session-state readEvents answered an event at ${String(index)}`);
    }
    return { index, json: entry.event };
  });
}

/**
 * The platform-backed session state store.
 *
 * @internal
 */
export function createPlatformStateBackend(
  options: PlatformSessionStateOptions,
): SessionStateBackend {
  return {
    name: "platform",
    // Earned: a committed value is a row in the platform's database, which outlives
    // every sandbox. See the module doc on why this flag must not be optimistic.
    durable: true,

    async load(sessionId) {
      return toSlotMap(await call(options, "load", { sessionId }));
    },

    async commit(sessionId, values) {
      // The store above calls this with only the slots that CHANGED, so the map is
      // small even when the session's state is not.
      await call(options, "commit", { sessionId, values: Object.fromEntries(values) });
    },

    async discard(sessionId) {
      await call(options, "discard", { sessionId });
    },

    async appendEvents(sessionId, events) {
      if (events.length === 0) return;
      await call(options, "appendEvents", {
        sessionId,
        // The indices travel as they are. They were assigned above this backend, so
        // renumbering them here would hand a client a position it was never told.
        events: events.map((e) => ({ index: e.index, event: e.json })),
      });
    },

    async readEvents(sessionId, startIndex, limit) {
      return toEvents(await call(options, "readEvents", { sessionId, startIndex, limit }));
    },

    async countEvents(sessionId) {
      const next = await call(options, "countEvents", { sessionId });
      // `typeof`, not `Number(next)`. `Number(null)` is 0 and `Number("")` is 0, so
      // coercing first turns two unreadable answers into the ONE value that must
      // never be guessed — a resumed session restarting its log at 0 overwrites its
      // own history. The same coercion trap as `parkedFor`'s in
      // `aai-server/workflow-queue-deliver.ts`, and it was live here until a spec
      // asked about `null` specifically.
      if (typeof next !== "number" || !Number.isInteger(next) || next < 0) {
        // NOT defaulted to 0. A resumed session that restarts its log at 0
        // overwrites its own history — see the module doc — so an answer this code
        // cannot read has to fail the hydrate rather than guess a position.
        throw new Error(`session-state countEvents answered ${String(next)}`);
      }
      return next;
    },
  };
}
