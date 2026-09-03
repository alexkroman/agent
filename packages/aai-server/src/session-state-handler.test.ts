// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/session-state` — the route the guest's third backend calls.
 *
 * The store's semantics are covered against real Postgres in
 * `platform-session-state.scenario.test.ts`. What these assert is the ROUTE: that
 * the bearer gates it, that the slug used in every statement comes from that bearer
 * rather than from the body, and that a malformed call is refused before the
 * database is touched.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import {
  bearerFor,
  createTestOrchestrator,
  deployAgent,
  fakeAdminDbOver,
  type TestFetch,
} from "./test-utils.ts";

const MINE = "mine-agent";
const THEIRS = "theirs-agent";

/**
 * A platform that records the statements and the params it was handed.
 *
 * `countAnswer` is what the `coalesce(max(event_index))` statement resolves to.
 * It defaults to a well-formed row; the cases that pass something else are
 * asking what the route does with an answer it cannot read, which is the one
 * question a fake `SqlExec` can put better than a real database can.
 */
async function platform(countAnswer: Record<string, unknown>[] = [{ next: 4 }]) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const adminDb = fakeAdminDbOver((sql, params) => {
    seen.push({ sql, params: params ?? [] });
    return sql.includes("coalesce(max(event_index)") ? countAnswer : [];
  });
  const harness = await createTestOrchestrator({ adminDb });
  for (const slug of [MINE, THEIRS]) await deployAgent(harness.fetch, slug);
  return { ...harness, seen, adminDb };
}

function callRoute(
  fetch: TestFetch,
  slug: string,
  body: unknown,
  bearer?: string,
): Promise<Response> {
  const authorization = bearer === undefined ? undefined : `Bearer ${bearer}`;
  return fetch(`/${slug}/session-state`, {
    method: "POST",
    headers: { "content-type": "application/json", ...omitUndefined({ authorization }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /:slug/session-state", () => {
  describe("authorization", () => {
    test("accepts the bearer this agent's guest holds", async () => {
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "load", sessionId: "s1" },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
    });

    test.each([
      ["no bearer", undefined],
      ["a guessed token", "0".repeat(64)],
    ])("refuses %s, and touches no statement", async (_label, bearer) => {
      const p = await platform();
      const res = await callRoute(p.fetch, MINE, { method: "load", sessionId: "s1" }, bearer);
      expect(res.status).toBe(401);
      expect(p.seen).toEqual([]);
    });

    test("refuses another agent's guest holding a valid token of its own", async () => {
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "load", sessionId: "s1" },
        await bearerFor(p.store, THEIRS),
      );
      expect(res.status).toBe(401);
      expect(p.seen).toEqual([]);
    });
  });

  /**
   * The tenant boundary, and it is one line: the slug in every statement comes from
   * the path (which the bearer just authenticated), never from the body.
   *
   * A body that names another agent must be IGNORED rather than refused, because
   * refusing would mean the field is read at all — and the whole property is that
   * it is not.
   */
  describe("the slug is the bearer's, not the body's", () => {
    test.each(["load", "commit", "discard", "appendEvents", "readEvents", "countEvents"])(
      "%s is scoped to the authenticated agent",
      async (method) => {
        const p = await platform();
        const res = await callRoute(
          p.fetch,
          MINE,
          {
            method,
            sessionId: "s1",
            // A body trying to name someone else, in every field it might.
            slug: THEIRS,
            values: {},
            events: [],
            startIndex: 0,
            limit: 10,
          },
          await bearerFor(p.store, MINE),
        );
        expect(res.status).toBe(200);
        // Every statement issued carries this agent's slug as its first parameter.
        for (const { params } of p.seen) expect(params[0]).toBe(MINE);
      },
    );
  });

  describe("the request", () => {
    test.each([
      ["an unknown method", { method: "drop", sessionId: "s1" }],
      ["no method", { sessionId: "s1" }],
      ["no sessionId", { method: "load" }],
      ["an empty sessionId", { method: "load", sessionId: "" }],
      ["a body that is not an object", '"a string"'],
      ["values that are not strings", { method: "commit", sessionId: "s1", values: { a: 7 } }],
      ["events that are not an array", { method: "appendEvents", sessionId: "s1", events: {} }],
      [
        "an event with no integer index",
        { method: "appendEvents", sessionId: "s1", events: [{ index: "x", event: "{}" }] },
      ],
      ["readEvents with no startIndex", { method: "readEvents", sessionId: "s1", limit: 10 }],
    ])("answers 400 for %s, before any statement", async (_label, body) => {
      const p = await platform();
      const res = await callRoute(p.fetch, MINE, body, await bearerFor(p.store, MINE));
      expect(res.status).toBe(400);
      expect(p.seen).toEqual([]);
    });

    /**
     * The stronger claim, and the one `p.seen` cannot make: a refused body costs no
     * CONNECTION, not merely no statement.
     *
     * Validation used to run inside `withReserved`, so every malformed call took
     * one of `ADMIN_POOL_MAX` reserved admin connections, held it across the
     * `requiredString` that refused the request, and gave it back — four of these
     * in flight and a legitimate call waits on a pool exhausted by requests that
     * were never going to run a query. `p.seen` stayed empty throughout, which is
     * why this needs its own spy: the statement recorder sees the work, and the
     * cost was the door.
     */
    test("reserves no connection for a body it is going to refuse", async () => {
      const p = await platform();
      const reserve = vi.spyOn(p.adminDb, "reserve");
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "readEvents", sessionId: "s1", limit: 10 },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(400);
      expect(reserve).not.toHaveBeenCalled();
    });

    test("does not echo the caller's method name back", async () => {
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "<script>alert(1)</script>", sessionId: "s1" },
        await bearerFor(p.store, MINE),
      );
      expect(await res.text()).not.toContain("script");
    });
  });

  test("countEvents answers the platform's own max + 1", async () => {
    // The fake answers 4 for the `coalesce(max(...))` statement, and the route must
    // pass that through rather than deriving anything from a row count.
    const p = await platform();
    const res = await callRoute(
      p.fetch,
      MINE,
      { method: "countEvents", sessionId: "s1" },
      await bearerFor(p.store, MINE),
    );
    expect(await res.json()).toEqual({ result: 4 });
  });

  test.each([
    // `Number(null)` is 0, which is why this one is the dangerous shape rather
    // than the obvious one: a NULL column used to pass the route's integer
    // check and answer the ONE value that must never be guessed.
    ["a NULL column", [{ next: null }]],
    ["no row at all", []],
  ])("refuses %s from countEvents with a 503, never `result: 0`", async (_label, answer) => {
    // `0` means "this session has no events", so a guessed 0 hands a resuming
    // guest an index it has already used and its appends overwrite the log from
    // the start — dropped in silence by `on conflict do nothing`. The runtime's
    // client refuses an unreadable `countEvents` for exactly that reason
    // (`aai-runtime/session-state-platform.ts`), and this end used to do the
    // opposite: the fallback made a broken read look like an empty session. A
    // 503 is `withReserved`'s mapping for a store failure, and the guest turns
    // it into a failed `hydrate`, which is the honest outcome.
    const p = await platform(answer);
    const res = await callRoute(
      p.fetch,
      MINE,
      { method: "countEvents", sessionId: "s1" },
      await bearerFor(p.store, MINE),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("result");
  });

  test("answers 501 with no platform database, because a retry will not make one", async () => {
    const harness = await createTestOrchestrator();
    await deployAgent(harness.fetch, MINE);
    const res = await callRoute(
      harness.fetch,
      MINE,
      { method: "load", sessionId: "s1" },
      await bearerFor(harness.store, MINE),
    );
    expect(res.status).toBe(501);
  });
});
