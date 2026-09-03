// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-keys` — the route the correlation index's third backend
 * calls.
 *
 * The store's semantics are covered against a real Postgres in
 * `platform-workflow-keys.scenario.test.ts`, and the whole `WorkflowKeyStore`
 * contract is covered over the client in
 * `aai-runtime/workflow-keys-conformance.test.ts`. What these assert is the
 * ROUTE: that the bearer gates it, that the slug in every statement comes from
 * that bearer rather than from the body, that a malformed call is refused before
 * the database is touched, and that the two field readers this route needed of
 * its own really behave differently from the shared ones.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { MAX_WORKFLOW_FIND_LIMIT } from "@alexkroman1/aai-runtime";
import { describe, expect, test, vi } from "vitest";
import {
  bearerFor,
  createTestOrchestrator,
  deployAgent,
  fakeAdminDbOver,
  type TestFetch,
} from "./test-utils.ts";
import { MAX_WORKFLOW_KEY_LOOKUP_LIMIT } from "./workflow-keys-handler.ts";

const MINE = "mine-agent";
const THEIRS = "theirs-agent";

/** A platform that records the statements and the params it was handed. */
async function platform(answer: Record<string, unknown>[] = [{ run_id: "wrun_1" }]) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const adminDb = fakeAdminDbOver((sql, params) => {
    seen.push({ sql, params: params ?? [] });
    return sql.includes("select run_id") ? answer : [];
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
  return fetch(`/${slug}/workflow-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", ...omitUndefined({ authorization }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const RECORD = {
  method: "record",
  runId: "wrun_1",
  workflow: "digest",
  key: "+14155550123",
  createdAt: 1_700_000_000_000,
};
const LOOKUP = { method: "lookup", workflow: "digest", key: "+14155550123", limit: 20 };

describe("POST /:slug/workflow-keys", () => {
  describe("authorization", () => {
    test("accepts the bearer this agent's guest holds", async () => {
      const p = await platform();
      const res = await callRoute(p.fetch, MINE, RECORD, await bearerFor(p.store, MINE));
      expect(res.status).toBe(200);
    });

    test.each([
      ["no bearer", undefined],
      ["a guessed token", "0".repeat(64)],
    ])("refuses %s, and touches no statement", async (_label, bearer) => {
      const p = await platform();
      const res = await callRoute(p.fetch, MINE, LOOKUP, bearer);
      expect(res.status).toBe(401);
      expect(p.seen).toEqual([]);
    });

    test("refuses another agent's guest holding a valid token of its own", async () => {
      const p = await platform();
      const res = await callRoute(p.fetch, MINE, LOOKUP, await bearerFor(p.store, THEIRS));
      expect(res.status).toBe(401);
      expect(p.seen).toEqual([]);
    });
  });

  /**
   * The tenant boundary, and it is one line: the slug in every statement comes
   * from the path (which the bearer just authenticated), never from the body.
   *
   * A body that names another agent must be IGNORED rather than refused, because
   * refusing would mean the field is read at all — and the whole property is that
   * it is not.
   */
  describe("the slug is the bearer's, not the body's", () => {
    test.each([
      ["record", RECORD],
      ["lookup", LOOKUP],
    ])("%s is scoped to the authenticated agent", async (_label, body) => {
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        // A body trying to name someone else, in the one field it might.
        { ...body, slug: THEIRS },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
      expect(p.seen.length).toBeGreaterThan(0);
      for (const { params } of p.seen) expect(params[0]).toBe(MINE);
    });
  });

  describe("the request", () => {
    test.each([
      ["an unknown method", { ...RECORD, method: "forget" }],
      ["no method", { runId: "wrun_1", workflow: "digest", key: "k", createdAt: 1 }],
      ["a body that is not an object", '"a string"'],
      ["record with no runId", { ...RECORD, runId: undefined }],
      ["record with an empty runId", { ...RECORD, runId: "" }],
      ["record with no workflow", { ...RECORD, workflow: undefined }],
      ["record with no key at all", { ...RECORD, key: undefined }],
      ["record with a non-string key", { ...RECORD, key: 7 }],
      ["record with no createdAt", { ...RECORD, createdAt: undefined }],
      ["record with a fractional createdAt", { ...RECORD, createdAt: 1.5 }],
      ["lookup with no workflow", { ...LOOKUP, workflow: undefined }],
      ["lookup with no limit", { ...LOOKUP, limit: undefined }],
      ["lookup with a negative limit", { ...LOOKUP, limit: -1 }],
      ["lookup with a fractional limit", { ...LOOKUP, limit: 2.5 }],
      ["lookup over the ceiling", { ...LOOKUP, limit: MAX_WORKFLOW_KEY_LOOKUP_LIMIT + 1 }],
    ])("answers 400 for %s, before any statement", async (_label, body) => {
      const p = await platform();
      const res = await callRoute(p.fetch, MINE, body, await bearerFor(p.store, MINE));
      expect(res.status).toBe(400);
      expect(p.seen).toEqual([]);
    });

    /**
     * The stronger claim, and the one `p.seen` cannot make: a refused body costs
     * no CONNECTION, not merely no statement.
     *
     * Validation runs OUTSIDE `withReserved` — see `PlatformCall` — and the
     * statement recorder stays empty either way, so the ordering needs its own
     * spy. Four malformed calls in flight would otherwise hold the whole admin
     * pool across the `requiredString` that refuses them.
     */
    test("reserves no connection for a body it is going to refuse", async () => {
      const p = await platform();
      const reserve = vi.spyOn(p.adminDb, "reserve");
      const res = await callRoute(
        p.fetch,
        MINE,
        { ...LOOKUP, limit: -1 },
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
        { ...RECORD, method: "<script>alert(1)</script>" },
        await bearerFor(p.store, MINE),
      );
      expect(await res.text()).not.toContain("script");
    });
  });

  /**
   * Two readers this route has of its own, both because the shared ones answer
   * the wrong question for this seam — and both are contract points the other two
   * backends already satisfy, so a 400 here would make the platform arm refuse
   * what memory and Postgres store.
   */
  describe("the two fields the shared readers get wrong", () => {
    test("an EMPTY key is a key, not absence", async () => {
      // `requiredString` refuses `""`. A withheld caller ID IS an empty key, and
      // the shared conformance case "an EMPTY key is a key, not absence" asserts
      // both other backends store it — so this route reads `key` with a reader
      // that accepts it.
      const p = await platform();
      const bearer = await bearerFor(p.store, MINE);
      expect((await callRoute(p.fetch, MINE, { ...RECORD, key: "" }, bearer)).status).toBe(200);
      expect((await callRoute(p.fetch, MINE, { ...LOOKUP, key: "" }, bearer)).status).toBe(200);
      // And it reaches the statement as an empty string rather than being dropped.
      expect(p.seen.some(({ params }) => params.includes(""))).toBe(true);
    });

    test("a limit of ZERO is an empty page, not a refusal", async () => {
      // The journal route refuses 0; this one must not. `limit 0` is a promise
      // this seam makes — the shared case "a limit of ZERO answers an empty page,
      // not everything" is asserted of all three backends, because the other
      // reading of 0 is "unlimited".
      const p = await platform([]);
      const res = await callRoute(
        p.fetch,
        MINE,
        { ...LOOKUP, limit: 0 },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: [] });
    });
  });

  test("the ceiling is exactly what the SDK client clamps to", async () => {
    // Pinned equal, so raising either side is a decision the other is owed: a
    // lower ceiling here 400s a request the shipped client makes, and a higher
    // one is headroom nothing real reaches, i.e. a bound that cannot be observed
    // to work. `resolveFindLimit` is what clamps every `find` to this number.
    expect(MAX_WORKFLOW_KEY_LOOKUP_LIMIT).toBe(MAX_WORKFLOW_FIND_LIMIT);
    const p = await platform([]);
    const res = await callRoute(
      p.fetch,
      MINE,
      { ...LOOKUP, limit: MAX_WORKFLOW_FIND_LIMIT },
      await bearerFor(p.store, MINE),
    );
    expect(res.status).toBe(200);
  });

  test("lookup answers the run ids the store read, in order", async () => {
    const p = await platform([{ run_id: "wrun_2" }, { run_id: "wrun_1" }]);
    const res = await callRoute(p.fetch, MINE, LOOKUP, await bearerFor(p.store, MINE));
    expect(await res.json()).toEqual({ result: ["wrun_2", "wrun_1"] });
  });

  test("record answers a result rather than an empty body", async () => {
    // `null` and not `undefined`: the client goes through `platformResult`, which
    // treats a 200 with no `result` key as a contract change rather than as a
    // successful write.
    const p = await platform();
    const res = await callRoute(p.fetch, MINE, RECORD, await bearerFor(p.store, MINE));
    expect(await res.json()).toEqual({ result: null });
  });

  test("answers 501 with no platform database, because a retry will not make one", async () => {
    // Terminal for the guest, whose backend was chosen once at construction —
    // and a fallback here would silently return the index to memory, which is
    // the failure this route exists to end.
    const harness = await createTestOrchestrator();
    await deployAgent(harness.fetch, MINE);
    const res = await callRoute(harness.fetch, MINE, LOOKUP, await bearerFor(harness.store, MINE));
    expect(res.status).toBe(501);
  });
});
