// Copyright 2026 the AAI authors. MIT license.
/**
 * The {@link SessionStateBackend} contract's second half: the session EVENT LOG
 * — `appendEvents`, `readEvents`, `countEvents`.
 *
 * `session-state-conformance.ts` is the entry point and carries the argument for
 * the pattern and the arms; `session-state-conformance-slots.ts` is the leaf that
 * declares the arm vocabulary. This file is where the two properties the seam
 * actually depends on are asked of every backend:
 *
 * - **`countEvents` is `max + 1`, never a count.** The requirement is stated
 *   three times in prose — on the interface, in the Postgres backend's own SQL
 *   comment, and in the platform backend's header, each time as a claim about
 *   the OTHER backends ("both backends must answer `max + 1`, or the memory one
 *   stops being a valid double") — and until this file nothing compared them.
 *   A count is right only for a log dense from zero, and this one need not be:
 *   an event past `MAX_SESSION_EVENTS` advances the position without being
 *   stored, and a partly-failed flush leaves a hole. Under a count a resumed
 *   session is handed an index it has already used, its `tail` goes BACKWARDS,
 *   and the re-appended events are dropped by `on conflict do nothing` — a data
 *   loss with no error anywhere. So the sparse cases below are the point of the
 *   file, not its edges.
 * - **An append at a stored index is a NO-OP.** A retried flush after a partial
 *   failure must not be the thing that breaks a call, and "no-op" has a second
 *   half a happy path cannot see: the STORED event stands, because a client has
 *   already been told what is at that index.
 *
 * @internal
 */

import { describe, expect, test } from "vitest";
import { json, meaningOfEvents, type SessionStateArm } from "./session-state-conformance-slots.ts";

/** One event at an index, as the log records it. */
const at = (index: number, type: string) => ({ index, json: json({ type }) });

/**
 * The event half of the contract.
 *
 * @internal
 */
export function sessionStateEventConformance(arm: SessionStateArm): void {
  describe(`session-state conformance (events): ${arm.label}`, () => {
    describe("the log is appended at indices the CALLER assigned", () => {
      test("append then read answers the events in index order", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a"), at(1, "b")]);
        expect(meaningOfEvents(await backend.readEvents(sessionId, 0, 10))).toEqual([
          { index: 0, event: { type: "a" } },
          { index: 1, event: { type: "b" } },
        ]);
      });

      test("an index is never renumbered", async () => {
        // Indices are assigned by the log ABOVE this seam, synchronously, and a
        // client has already been told its position — so a backend that
        // helpfully renumbered a log starting at 7 would hand out cursors that
        // were never promised, and a reader resuming at 7 would find nothing.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(7, "a"), at(8, "b")]);
        expect((await backend.readEvents(sessionId, 0, 10)).map((e) => e.index)).toEqual([7, 8]);
      });

      test("events appended out of order come back IN order", async () => {
        // The memory backend sorts its keys and both databases answer
        // `order by event_index`. A backend answering in insertion order would
        // agree with them on every dense, in-order log and disagree here.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(2, "c")]);
        await backend.appendEvents(sessionId, [at(0, "a"), at(1, "b")]);
        expect((await backend.readEvents(sessionId, 0, 10)).map((e) => e.index)).toEqual([0, 1, 2]);
      });

      test("one session's log is invisible to another", async () => {
        const backend = arm.backend();
        const mine = arm.uid();
        const theirs = arm.uid();
        await backend.appendEvents(mine, [at(0, "a")]);
        expect(await backend.readEvents(theirs, 0, 10)).toEqual([]);
        expect(await backend.countEvents(theirs)).toBe(0);
      });
    });

    describe("readEvents is a CURSOR", () => {
      test("startIndex is INCLUSIVE", async () => {
        // `>= $2` in both databases and `index < startIndex` in memory. Off by
        // one here and a resuming reader silently skips the event it asked to
        // start at — which is the first one it has not seen.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a"), at(1, "b"), at(2, "c")]);
        expect((await backend.readEvents(sessionId, 1, 10)).map((e) => e.index)).toEqual([1, 2]);
      });

      test("limit truncates, and the page still begins at startIndex", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a"), at(1, "b"), at(2, "c"), at(3, "d")]);
        expect((await backend.readEvents(sessionId, 1, 2)).map((e) => e.index)).toEqual([1, 2]);
      });

      test("a limit of zero answers an empty page", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a")]);
        expect(await backend.readEvents(sessionId, 0, 0)).toEqual([]);
      });

      test("a read PAST the tail answers an empty page, not a failure", async () => {
        // Legitimate rather than exceptional: `startIndex` is a caller's cursor
        // and a caller may be caught up. It is also the case the
        // `session.page.tail` invariant was first stated WRONG for — a page
        // starting past the tail says nothing about the tail.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a")]);
        expect(await backend.readEvents(sessionId, 5, 10)).toEqual([]);
      });

      test("a read at MAX_SAFE_INTEGER answers an empty page", async () => {
        // The boundary `session-events-api.ts` CLAMPS a query string to, and it
        // clamps to exactly this number because the value becomes a `bigint`
        // parameter: anything past ~9.22e18 is out of range for the column and
        // anything past ~1e21 arrives as the string `"1e+30"`, a syntax error.
        // Both answered `500` on a real Postgres and neither is representable
        // in memory — so the clamp's target is asked of every backend HERE,
        // where the promise it rests on can be checked, rather than trusted
        // from the route.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a")]);
        expect(await backend.readEvents(sessionId, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
      });

      test("a read of a session with no events answers an empty page", async () => {
        const backend = arm.backend();
        expect(await backend.readEvents(arm.uid(), 0, 10)).toEqual([]);
      });

      test("a SPARSE log skips its holes and keeps its order", async () => {
        // The shape the retention cap and a partly-failed flush both produce,
        // and the one every `count`-shaped answer gets wrong.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a"), at(3, "d"), at(9, "j")]);
        expect((await backend.readEvents(sessionId, 1, 10)).map((e) => e.index)).toEqual([3, 9]);
      });
    });

    describe("an append is IDEMPOTENT per index", () => {
      test("appending nothing is a no-op, not a failure", async () => {
        // The three backends reach this three ways — the client returns before
        // it POSTs, the platform route returns before it inserts, and the
        // postgres statement `unnest`es two empty arrays — so "silent" is a
        // property to assert rather than to read off any one of them.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await expect(backend.appendEvents(sessionId, [])).resolves.toBeUndefined();
        expect(await backend.countEvents(sessionId)).toBe(0);
        expect(await backend.readEvents(sessionId, 0, 10)).toEqual([]);
      });

      test("re-appending a stored index does not FAIL", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a")]);
        await expect(backend.appendEvents(sessionId, [at(0, "a")])).resolves.toBeUndefined();
        expect((await backend.readEvents(sessionId, 0, 10)).length).toBe(1);
      });

      test("re-appending a stored index KEEPS the stored event", async () => {
        // The half of "no-op" a passing retry hides, and the divergence this
        // table was written to find: both databases are
        // `on conflict (…, event_index) do nothing`, which keeps the row, while
        // the memory backend was a bare `log.set` — an UPSERT. So the reference
        // every other spec in this package uses as its double answered a
        // retried flush differently from the two backends that run in
        // production, on the one code path a retry is FOR.
        //
        // Memory is the side that was wrong: an index a client has already been
        // told about is a fact, and there is no writer above this seam that
        // means to revise one. See `session-state-memory.ts`'s `appendEvents`.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "first")]);
        await backend.appendEvents(sessionId, [at(0, "second")]);
        expect(meaningOfEvents(await backend.readEvents(sessionId, 0, 10))).toEqual([
          { index: 0, event: { type: "first" } },
        ]);
      });

      test("an OVERLAPPING retry keeps what was stored and adds what was not", async () => {
        // What a real retried flush looks like: the batch is re-sent whole, so
        // it straddles the indices that landed and the ones that did not.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a"), at(1, "b")]);
        await backend.appendEvents(sessionId, [at(1, "b-again"), at(2, "c")]);
        expect(meaningOfEvents(await backend.readEvents(sessionId, 0, 10))).toEqual([
          { index: 0, event: { type: "a" } },
          { index: 1, event: { type: "b" } },
          { index: 2, event: { type: "c" } },
        ]);
      });
    });

    describe("countEvents is `max + 1`, never a count", () => {
      test("zero for a session with no events", async () => {
        // NOT a rejection and NOT `undefined`: this is read on every hydrate,
        // and a fresh session is the common case.
        const backend = arm.backend();
        expect(await backend.countEvents(arm.uid())).toBe(0);
      });

      test("one past the highest index of a DENSE log", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a"), at(1, "b"), at(2, "c")]);
        expect(await backend.countEvents(sessionId)).toBe(3);
      });

      test("one past the highest index of a SPARSE log, which a count is not", async () => {
        // The case the whole answer exists for: one event stored at index 5,
        // because the four before it advanced the position without being
        // stored. `max + 1` says 6; a count says 1; and a session resuming on 1
        // overwrites four indices a client already holds — silently, because
        // `on conflict do nothing` discards the re-appends.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(5, "f")]);
        expect(await backend.countEvents(sessionId)).toBe(6);
      });

      test("a HOLE in the middle does not lower it", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a"), at(7, "h")]);
        expect(await backend.countEvents(sessionId)).toBe(8);
      });

      test("a re-appended index does not move it", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [at(0, "a"), at(1, "b")]);
        await backend.appendEvents(sessionId, [at(1, "b")]);
        expect(await backend.countEvents(sessionId)).toBe(2);
      });

      test("another session's events do not raise it", async () => {
        const backend = arm.backend();
        const mine = arm.uid();
        const theirs = arm.uid();
        await backend.appendEvents(theirs, [at(0, "a"), at(1, "b"), at(2, "c")]);
        await backend.appendEvents(mine, [at(0, "a")]);
        expect(await backend.countEvents(mine)).toBe(1);
      });
    });
  });
}
