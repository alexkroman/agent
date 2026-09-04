// Copyright 2026 the AAI authors. MIT license.
/**
 * The {@link SessionStateBackend} contract's first half: a session's SLOTS —
 * `load`, `commit`, `discard`.
 *
 * `session-state-conformance.ts` is the entry point and carries the whole
 * argument for the pattern, the arms, and the rules for a new case. This file is
 * the shared VOCABULARY every arm and both halves need ({@link SessionStateArm},
 * {@link sessionStateIds}, {@link meaningOf}) plus the cases that read and write
 * slot values. The event half is `session-state-conformance-events.ts`; the
 * split is the file-length cap's doing and lands on the seam the interface
 * itself splits on — the type's own doc calls slots and the event log "two
 * consumers, one backend".
 *
 * The vocabulary lives HERE rather than in the entry module for one mechanical
 * reason: the entry module imports both halves, so a helper declared there and
 * imported back would be a cycle. This is the leaf.
 *
 * @internal
 */

import { describe, expect, test } from "vitest";
import type { SessionStateBackend, StoredSessionEvent } from "./session-state-store.ts";

/**
 * One backend under test.
 *
 * `backend()` is called per case rather than once, so an arm may hand back a
 * fresh backend (memory) or the one shared backend its tier can afford
 * (Postgres, the platform client) without any case knowing which.
 */
export type SessionStateArm = {
  /** What the reporter calls this backend. */
  label: string;
  /** The backend one case runs against. */
  backend: () => SessionStateBackend;
  /** A fresh, collision-proof session id per call — see the arm-independence rule. */
  uid: () => string;
};

/**
 * A fresh session id per call, unique across processes and across two runs of
 * one file.
 *
 * The pid is in the PREFIX for the reason `CONFORMANCE_PREFIX` in
 * `aai-server/store-conformance.ts` puts it there. Here the scenario arm drops a
 * whole schema instead, so the pid is belt-and-braces — but the timestamp is
 * not: a re-run of one file against a database that survived it would otherwise
 * find a session's rows already there and report a contract failure for a
 * housekeeping one.
 */
export function sessionStateIds(label: string): () => string {
  let n = 0;
  return () => `sess-${label}-${process.pid}-${Date.now().toString(36)}-${n++}`;
}

/**
 * A stored map as its MEANING: every value parsed.
 *
 * **Values cross this seam as serialized JSON and come back re-serialized by
 * whoever stored them, so a byte comparison is a comparison of storage
 * engines.** Both databases hold `jsonb`, which NORMALIZES — `{"n":1}` is
 * written and read back as `{"n": 1}` — while the memory backend preserves the
 * exact string it was handed. That divergence is real, documented in
 * `aai-server/platform-session-state.ts`, and harmless, because every consumer
 * above this seam parses (`hydrateOne` is a `JSON.parse`). A case that asserted
 * bytes would fail on the spelling and say nothing about the behaviour, which is
 * the opposite of what a contract table is for.
 */
export function meaningOf(stored: ReadonlyMap<string, string>): Record<string, unknown> {
  return Object.fromEntries([...stored].map(([slot, json]) => [slot, JSON.parse(json)]));
}

/** The same rule for the event log: an index, and the event's MEANING. */
export function meaningOfEvents(
  events: readonly StoredSessionEvent[],
): { index: number; event: unknown }[] {
  return events.map((e) => ({ index: e.index, event: JSON.parse(e.json) }));
}

/** One slot's value, serialized the way the store above serializes it. */
export const json = (value: unknown): string => JSON.stringify(value) ?? "null";

/** The map shape `commit` takes, from plain values. */
export function slots(values: Record<string, unknown>): Map<string, string> {
  return new Map(Object.entries(values).map(([slot, value]) => [slot, json(value)]));
}

/**
 * The slot half of the contract.
 *
 * @internal
 */
export function sessionStateSlotConformance(arm: SessionStateArm): void {
  describe(`session-state conformance (slots): ${arm.label}`, () => {
    describe("a slot is committed and read back whole", () => {
      test("load answers what commit stored", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.commit(sessionId, slots({ cart: { items: ["apple"], total: 1.5 } }));
        expect(meaningOf(await backend.load(sessionId))).toEqual({
          cart: { items: ["apple"], total: 1.5 },
        });
      });

      test("however many slots changed, all of them land", async () => {
        // One `unnest` statement carries the whole map in both databases, so
        // "the second slot silently did not make it" is a shape this can have
        // and the single-slot case above cannot see.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.commit(sessionId, slots({ cart: 1, flags: { seen: true }, note: "hi" }));
        expect(meaningOf(await backend.load(sessionId))).toEqual({
          cart: 1,
          flags: { seen: true },
          note: "hi",
        });
      });

      test("one session's slots are invisible to another", async () => {
        // The keying, asked directly. On the platform the row is keyed by
        // `(slug, session_id, slot)` and the slug is taken from the bearer, so
        // this is the half of that key a guest can influence.
        const backend = arm.backend();
        const mine = arm.uid();
        const theirs = arm.uid();
        await backend.commit(mine, slots({ cart: "mine" }));
        expect(meaningOf(await backend.load(theirs))).toEqual({});
      });
    });

    describe("the absence matrix", () => {
      // Every drift a review of these three backends found was an edge case
      // about ABSENCE — `undefined` against `null` against `""` against missing
      // — so the empty, the null and the never-written each get a case of their
      // own rather than being left to a happy path's edges.
      test("load answers an EMPTY map for a session nobody wrote", async () => {
        // Never `undefined`, and never a rejection: `hydrate` calls this on
        // EVERY session start, and a fresh session is the common case.
        const backend = arm.backend();
        const loaded = await backend.load(arm.uid());
        expect(loaded).toBeInstanceOf(Map);
        expect(loaded.size).toBe(0);
      });

      test("a slot never written is ABSENT, not present-and-empty", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.commit(sessionId, slots({ cart: 1 }));
        const loaded = await backend.load(sessionId);
        expect(loaded.has("flags")).toBe(false);
        expect(loaded.get("flags")).toBeUndefined();
      });

      test("JSON null is a VALUE, and survives as one", async () => {
        // The store above spells an `undefined` slot value as the string
        // `"null"` (`JSON.stringify(undefined) ?? "null"`), so this is the wire
        // form of "the author set it to nothing" — distinct from the slot not
        // being there, which the case above covers. A backend that read `null`
        // as absence would drop it on the way back and the author's write would
        // vanish with no error anywhere.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.commit(sessionId, slots({ note: null }));
        const loaded = await backend.load(sessionId);
        expect(loaded.has("note")).toBe(true);
        expect(meaningOf(loaded)).toEqual({ note: null });
      });

      test("an empty string is a VALUE too", async () => {
        // `""` standing in for a missing value was one of the five drifts the
        // journal's table found, twice over, so it is asked here rather than
        // assumed.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.commit(sessionId, slots({ note: "" }));
        expect(meaningOf(await backend.load(sessionId))).toEqual({ note: "" });
      });

      test("committing NOTHING is a no-op, not a failure", async () => {
        // `flush` only calls `commit` with a non-empty map today, but the
        // platform route and the postgres statement disagree on how they reach
        // that: one returns before issuing SQL, the other issues an `unnest` of
        // two empty arrays. Both must be silent, and neither may leave a
        // session behind that `load` then answers for.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await expect(backend.commit(sessionId, new Map())).resolves.toBeUndefined();
        expect((await backend.load(sessionId)).size).toBe(0);
      });
    });

    describe("a commit MERGES, and a re-commit REPLACES", () => {
      test("a commit naming one slot leaves the others alone", async () => {
        // Load-bearing rather than incidental: `flush` sends only the slots
        // whose serialization CHANGED, so a backend that replaced the session's
        // whole record would forget every slot the tool call did not touch —
        // the exact bug ("remembered the conversation, forgot the cart") this
        // whole store exists to fix, arriving from the other side.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.commit(sessionId, slots({ cart: 1, flags: { seen: true } }));
        await backend.commit(sessionId, slots({ cart: 2 }));
        expect(meaningOf(await backend.load(sessionId))).toEqual({
          cart: 2,
          flags: { seen: true },
        });
      });

      test("a re-commit of one slot REPLACES its value", async () => {
        // The deliberate contrast with `appendEvents`, whose second write is a
        // NO-OP. A slot is a value with a history nobody keeps; an event log
        // entry is a fact already handed to a client. Both databases spell the
        // difference in one clause — `do update set value = excluded.value`
        // against `do nothing` — so the pair of cases is what stops a backend
        // picking one rule for both tables.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.commit(sessionId, slots({ cart: { items: ["a"] } }));
        await backend.commit(sessionId, slots({ cart: { items: ["a", "b"] } }));
        expect(meaningOf(await backend.load(sessionId))).toEqual({ cart: { items: ["a", "b"] } });
      });
    });

    describe("reclamation", () => {
      test("discard drops this session's slots", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.commit(sessionId, slots({ cart: 1 }));
        await backend.discard(sessionId);
        expect((await backend.load(sessionId)).size).toBe(0);
      });

      test("discard drops this session's EVENT LOG too", async () => {
        // **The contract, and it was the table's one deliberately
        // underspecified point until it was decided.** Memory and the platform
        // route already reclaimed both; `session-state-postgres.ts` dropped
        // SLOTS ONLY and left the log to the retention sweep, so "discarded"
        // meant two different things depending on where the session ran — the
        // same agent's ended session kept a readable log for up to two days on a
        // self-hosted database and lost it immediately on the platform. That is
        // unusable for a caller and invisible in a diff, and the log is a
        // debugging convenience rather than a record anything reads back, so the
        // platform's answer is the contract and Postgres was the outlier.
        //
        // Asserted here rather than named in prose because prose is what let it
        // sit: the interface said `discard` "reclaims what the backend is
        // ALLOWED to reclaim, which is not always both", the two databases
        // disagreed under that sentence, and nothing failed. Being a SHARED case
        // it now runs on every arm, the real-route one included.
        //
        // Both readers, because they answer from different columns: `readEvents`
        // reads the rows and `countEvents` reads `max + 1` over them, so a
        // backend that deleted the rows while leaving the position behind would
        // hand a fresh session an index it must not start at.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [
          { index: 0, json: json({ type: "a" }) },
          { index: 1, json: json({ type: "b" }) },
        ]);
        await backend.discard(sessionId);
        expect(await backend.readEvents(sessionId, 0, 10)).toEqual([]);
        expect(await backend.countEvents(sessionId)).toBe(0);
      });

      test("discard drops NOBODY else's event log", async () => {
        // The other half of the widened reach, and the one a `delete` missing
        // its `session_id` predicate would break. Cheap, and the reason it is
        // not skipped: widening what a statement DELETES is exactly when a
        // scoping mistake is made.
        const backend = arm.backend();
        const keep = arm.uid();
        const drop = arm.uid();
        await backend.appendEvents(keep, [{ index: 0, json: json({ type: "keep" }) }]);
        await backend.appendEvents(drop, [{ index: 0, json: json({ type: "drop" }) }]);
        await backend.discard(drop);
        expect(meaningOfEvents(await backend.readEvents(keep, 0, 10))).toEqual([
          { index: 0, event: { type: "keep" } },
        ]);
        expect(await backend.countEvents(keep)).toBe(1);
      });

      test("discard drops NOBODY else's", async () => {
        const backend = arm.backend();
        const keep = arm.uid();
        const drop = arm.uid();
        await backend.commit(keep, slots({ cart: "keep" }));
        await backend.commit(drop, slots({ cart: "drop" }));
        await backend.discard(drop);
        expect(meaningOf(await backend.load(keep))).toEqual({ cart: "keep" });
      });

      test("discarding a session that never existed RESOLVES", async () => {
        // The grace sweep is fire-and-forget (`void backend.discard(…)`), so a
        // rejection here is an unhandled rejection in a timer with nobody to
        // report to — and a session that ended before it ever wrote a slot is
        // the ordinary case, not an exotic one.
        const backend = arm.backend();
        await expect(backend.discard(arm.uid())).resolves.toBeUndefined();
      });
    });

    describe("slots and the event log are separate", () => {
      test("appending events creates no slot", async () => {
        // One backend, two consumers — the interface says so — and nothing
        // above it would notice the two records bleeding into each other until
        // a resumed session hydrated a slot named after an event index.
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.appendEvents(sessionId, [{ index: 0, json: json({ type: "x" }) }]);
        expect((await backend.load(sessionId)).size).toBe(0);
      });

      test("committing a slot creates no event", async () => {
        const backend = arm.backend();
        const sessionId = arm.uid();
        await backend.commit(sessionId, slots({ cart: 1 }));
        expect(await backend.countEvents(sessionId)).toBe(0);
        expect(await backend.readEvents(sessionId, 0, 10)).toEqual([]);
      });
    });
  });
}
