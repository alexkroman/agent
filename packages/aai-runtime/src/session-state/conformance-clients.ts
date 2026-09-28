// Copyright 2026 the AAI authors. MIT license.
/**
 * The CLIENT half of the session-state contract — the cases every backend that
 * keeps a client log (`clients.ts`) must answer the same way.
 *
 * Its own file for the reason the slot and event halves are: one concern per
 * case list, and `conformance.ts` composes them. Run only on an arm that
 * declares `clientLog`, because the platform backend deliberately has none.
 *
 * The case worth reading first is the second: a bound session's EVENTS survive
 * `discard` while its slots do not. That is the one place this half changes the
 * other two — `conformance-events.ts` asserts that discard reclaims both, and
 * that stays true of every session nobody bound.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { json, type SessionStateArm } from "./conformance-slots.ts";

/** One event at an index, as the log records it. */
const at = (index: number) => ({ index, json: json({ type: "x", index }) });

/** A client id no other case (or run) shares — the backend is one per arm. */
const clientOf = (arm: SessionStateArm) => `client-${arm.uid()}`;

/** The clock both backends compare `since` against has millisecond grain. */
const tick = () => sleep(5);

/**
 * Register the client cases for one arm.
 *
 * @internal
 */
export function sessionStateClientConformance(arm: SessionStateArm): void {
  describe(`session-state conformance (clients): ${arm.label}`, () => {
    test("a bound session is listed under its client, and nobody else's", async () => {
      const backend = arm.backend();
      const mine = clientOf(arm);
      const theirs = clientOf(arm);
      const sessionId = arm.uid();
      await backend.bindClient?.(sessionId, mine);

      const listed = await backend.clientSessions?.(mine, { limit: 10 });
      expect(listed?.map((s) => s.sessionId)).toEqual([sessionId]);
      expect(await backend.clientSessions?.(theirs, { limit: 10 })).toEqual([]);
    });

    test("discard keeps a bound session's EVENTS and reclaims its slots", async () => {
      const backend = arm.backend();
      const sessionId = arm.uid();
      await backend.bindClient?.(sessionId, clientOf(arm));
      await backend.commit(sessionId, new Map([["cart", json({ n: 1 })]]));
      await backend.appendEvents(sessionId, [at(0), at(1)]);

      await backend.discard(sessionId);

      expect((await backend.load(sessionId)).size).toBe(0);
      expect((await backend.readEvents(sessionId, 0, 10)).map((e) => e.index)).toEqual([0, 1]);
    });

    test("newest first, capped by `limit`", async () => {
      const backend = arm.backend();
      const client = clientOf(arm);
      const first = arm.uid();
      const second = arm.uid();
      await backend.bindClient?.(first, client);
      await tick();
      await backend.bindClient?.(second, client);

      const all = await backend.clientSessions?.(client, { limit: 10 });
      expect(all?.map((s) => s.sessionId)).toEqual([second, first]);
      const one = await backend.clientSessions?.(client, { limit: 1 });
      expect(one?.map((s) => s.sessionId)).toEqual([second]);
    });

    test("a re-bind keeps `startedAt` and moves the session to the new client", async () => {
      const backend = arm.backend();
      const before = clientOf(arm);
      const after = clientOf(arm);
      const sessionId = arm.uid();
      await backend.bindClient?.(sessionId, before);
      const [original] = (await backend.clientSessions?.(before, { limit: 1 })) ?? [];
      await tick();
      await backend.bindClient?.(sessionId, after);

      expect(await backend.clientSessions?.(before, { limit: 10 })).toEqual([]);
      const [moved] = (await backend.clientSessions?.(after, { limit: 1 })) ?? [];
      expect(moved?.startedAt).toBe(original?.startedAt);
    });

    test("`since` filters on the last APPEND, not the bind", async () => {
      const backend = arm.backend();
      const client = clientOf(arm);
      const quiet = arm.uid();
      const active = arm.uid();
      await backend.bindClient?.(quiet, client);
      await backend.bindClient?.(active, client);
      await tick();
      const cutoff = Date.now();
      await tick();
      await backend.appendEvents(active, [at(0)]);

      const since = await backend.clientSessions?.(client, { since: cutoff, limit: 10 });
      expect(since?.map((s) => s.sessionId)).toEqual([active]);
    });
  });
}
