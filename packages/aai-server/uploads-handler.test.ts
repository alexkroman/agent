// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/upload-records` — the route the guest's platform upload backend calls.
 *
 * The store's semantics are covered against real Postgres in
 * `platform-uploads.scenario.test.ts`. What these assert is the ROUTE: that the
 * bearer gates it, that the slug used in every statement comes from that bearer
 * rather than the body, that a malformed call is refused before the database is
 * touched, and that a CLAIMED id answers 409 rather than being flattened into a
 * generic failure.
 *
 * That last one is the only status here a caller branches on: it is what makes a
 * caller-chosen upload id safe, and the guest translates it back into its own
 * `UploadIdTakenError` instead of retrying.
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

const MINE = "mine-upl";
const THEIRS = "theirs-upl";

/**
 * One stored row, in the shapes the DRIVER answers with.
 *
 * `size` and `expected` as STRINGS is not incidental — they are `bigint` columns
 * and postgres.js stringifies them, so a fake that handed back numbers would let a
 * coercion bug through. `parts` as an already-parsed array is what the driver does
 * with `jsonb`.
 */
const STORED_ROW = {
  name: "clip.wav",
  type: "audio/wav",
  size: "3000000000",
  complete: false,
  expected: "4000000000",
  parts: [{ at: 0, bytes: 512 }],
};

/** A platform that records the statements and params it was handed. */
async function platform(
  rows: Record<string, unknown>[] = [],
  readRow: Record<string, unknown> | null = STORED_ROW,
) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const adminDb = fakeAdminDbOver((sql, params) => {
    seen.push({ sql, params: params ?? [] });
    // A claim's `returning id` is what says it was NOT taken; anything else reads
    // as "no rows", which is what the 409 path needs.
    if (sql.includes("on conflict (slug, id) do nothing")) return rows;
    if (sql.includes("from aai_platform.workflow_uploads")) {
      return readRow === null ? [] : [readRow];
    }
    return [];
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
  return fetch(`/${slug}/upload-records`, {
    method: "POST",
    headers: { "content-type": "application/json", ...omitUndefined({ authorization }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const RECORD = { name: "clip.wav", type: "audio/wav", size: 0, complete: false, parts: [] };

describe("POST /:slug/upload-records", () => {
  describe("authorization", () => {
    test("refuses no bearer, and touches no statement", async () => {
      const { fetch, seen } = await platform();
      const res = await callRoute(fetch, MINE, { method: "read", id: "u1" });
      expect(res.status).toBe(401);
      // The point of asserting the statements too: a route that authorized AFTER
      // reading would leak whether a record exists through timing or an error.
      expect(seen.filter((s) => s.sql.includes("workflow_uploads"))).toEqual([]);
    });

    test("refuses ANOTHER agent's bearer", async () => {
      const { fetch, store } = await platform();
      const res = await callRoute(
        fetch,
        MINE,
        { method: "read", id: "u1" },
        await bearerFor(store, THEIRS),
      );
      expect(res.status).toBe(401);
    });

    test("accepts the bearer this agent's guest holds", async () => {
      const { fetch, store } = await platform();
      const res = await callRoute(
        fetch,
        MINE,
        { method: "read", id: "u1" },
        await bearerFor(store, MINE),
      );
      expect(res.status).toBe(200);
    });
  });

  describe("the slug is the bearer's, never the body's", () => {
    test("a body naming another slug does not reach its rows", async () => {
      const { fetch, store, seen } = await platform();
      await callRoute(
        fetch,
        MINE,
        // `slug` here is a lie a guest could tell. It must be ignored entirely.
        { method: "read", id: "u1", slug: THEIRS },
        await bearerFor(store, MINE),
      );
      const read = seen.find((s) => s.sql.includes("from aai_platform.workflow_uploads"));
      expect(read?.params[0]).toBe(MINE);
    });
  });

  describe("validation, before the database is touched", () => {
    test("an unknown method is refused without echoing it", async () => {
      const { fetch, store, seen } = await platform();
      const res = await callRoute(
        fetch,
        MINE,
        { method: "<script>", id: "u1" },
        await bearerFor(store, MINE),
      );
      expect(res.status).toBe(400);
      // Not echoed: the reply is a tenant's to read.
      expect(await res.text()).not.toContain("<script>");
      expect(seen.filter((s) => s.sql.includes("workflow_uploads"))).toEqual([]);
    });

    test("a body that is not JSON is refused", async () => {
      const { fetch, store } = await platform();
      const res = await callRoute(fetch, MINE, "not json", await bearerFor(store, MINE));
      expect(res.status).toBe(400);
    });

    test("a missing id is refused", async () => {
      const { fetch, store } = await platform();
      const res = await callRoute(fetch, MINE, { method: "read" }, await bearerFor(store, MINE));
      expect(res.status).toBe(400);
    });

    test("a negative size is refused", async () => {
      // A size is a byte count; a negative one would make the contiguous prefix
      // arithmetic nonsense rather than failing loudly.
      const { fetch, store } = await platform();
      const res = await callRoute(
        fetch,
        MINE,
        { method: "finish", id: "u1", size: -1 },
        await bearerFor(store, MINE),
      );
      expect(res.status).toBe(400);
    });

    test("a malformed part is REFUSED, unlike on the way out", async () => {
      // Asymmetric on purpose: a bad window arriving from the guest is a bug in the
      // guest, and storing it would leave a record whose prefix disagrees with its
      // bytes. On a READ a corrupt entry is dropped instead, because there the
      // alternative is an upload nothing can ever read.
      const { fetch, store } = await platform();
      const res = await callRoute(
        fetch,
        MINE,
        { method: "update", id: "u1", size: 4, complete: false, parts: [{ at: "x", bytes: 4 }] },
        await bearerFor(store, MINE),
      );
      expect(res.status).toBe(400);
    });

    test("a non-integer expected is refused", async () => {
      const { fetch, store } = await platform();
      const res = await callRoute(
        fetch,
        MINE,
        { method: "claim", id: "u1", ...RECORD, expected: 1.5 },
        await bearerFor(store, MINE),
      );
      expect(res.status).toBe(400);
    });

    /**
     * The stronger claim, and the one the statement recorder cannot make: a refused
     * body costs no CONNECTION, not merely no statement.
     *
     * Per-field validation used to run inside `withReserved`, so every malformed
     * call took one of `ADMIN_POOL_MAX` reserved admin connections, held it across
     * the read that refused the request, and gave it back. `seen` stayed empty
     * throughout — the cost was the door, not the query — which is why this needs
     * its own spy. See `PlatformCall` in `_platform-route.ts`.
     */
    test("reserves no connection for a body it is going to refuse", async () => {
      const { fetch, store, adminDb } = await platform();
      const reserve = vi.spyOn(adminDb, "reserve");
      const res = await callRoute(
        fetch,
        MINE,
        { method: "finish", id: "u1" },
        await bearerFor(store, MINE),
      );
      expect(res.status).toBe(400);
      expect(reserve).not.toHaveBeenCalled();
    });
  });

  describe("a claimed id", () => {
    test("answers 409, which is what makes a caller-chosen id safe", async () => {
      // No rows from the conditional insert means the id was held. It must not be a
      // 5xx: the guest translates 409 into `UploadIdTakenError` and anything else
      // into a retry.
      const { fetch, store } = await platform([]);
      const res = await callRoute(
        fetch,
        MINE,
        { method: "claim", id: "dup", ...RECORD },
        await bearerFor(store, MINE),
      );
      expect(res.status).toBe(409);
    });

    test("a free id answers 200", async () => {
      const { fetch, store } = await platform([{ id: "fresh" }]);
      const res = await callRoute(
        fetch,
        MINE,
        { method: "claim", id: "fresh", ...RECORD },
        await bearerFor(store, MINE),
      );
      expect(res.status).toBe(200);
    });
  });

  describe("what a read hands back", () => {
    test("coerces the driver's bigint STRINGS into numbers", async () => {
      // The columns are `bigint`, which postgres.js stringifies. A wire shape
      // carrying "3000000000" would make the guest's own arithmetic silently
      // string-concatenate.
      const { fetch, store } = await platform();
      const res = await callRoute(
        fetch,
        MINE,
        { method: "read", id: "u1" },
        await bearerFor(store, MINE),
      );
      const body = (await res.json()) as { result: { size: unknown; expected: unknown } };
      expect(body.result.size).toBe(3_000_000_000);
      expect(body.result.expected).toBe(4_000_000_000);
    });

    test("passes the boundary list through unchanged", async () => {
      const { fetch, store } = await platform();
      const res = await callRoute(
        fetch,
        MINE,
        { method: "read", id: "u1" },
        await bearerFor(store, MINE),
      );
      const body = (await res.json()) as { result: { parts: unknown } };
      expect(body.result.parts).toEqual([{ at: 0, bytes: 512 }]);
    });

    test("an absent expected stays ABSENT rather than becoming 0", async () => {
      // The trap: absent means "not a parts upload", which decides whether
      // completion is judged by a declared total or by the body ending.
      const { fetch, store } = await platform([], { ...STORED_ROW, expected: null });
      const res = await callRoute(
        fetch,
        MINE,
        { method: "read", id: "u1" },
        await bearerFor(store, MINE),
      );
      const body = (await res.json()) as { result: Record<string, unknown> };
      expect("expected" in body.result).toBe(false);
    });

    test("no row answers null, which is not the same as a malformed one", async () => {
      const { fetch, store } = await platform([], null);
      const res = await callRoute(
        fetch,
        MINE,
        { method: "read", id: "u1" },
        await bearerFor(store, MINE),
      );
      expect((await res.json()) as unknown).toEqual({ result: null });
    });

    test("a row whose size is unreadable answers null rather than 0", async () => {
      // `Number(null)` is 0, so a coercion-first read would report a plausible
      // empty upload for a row it could not actually parse.
      const { fetch, store } = await platform([], { ...STORED_ROW, size: null });
      const res = await callRoute(
        fetch,
        MINE,
        { method: "read", id: "u1" },
        await bearerFor(store, MINE),
      );
      expect((await res.json()) as unknown).toEqual({ result: null });
    });

    test("DROPS a malformed window rather than failing the whole record", async () => {
      // Asymmetric with the write path on purpose: a corrupt entry would make an
      // upload unreadable forever, where a missing window only shortens the prefix.
      const { fetch, store } = await platform([], {
        ...STORED_ROW,
        parts: [{ at: 0, bytes: 8 }, { at: "x", bytes: 4 }, { bytes: 2 }],
      });
      const res = await callRoute(
        fetch,
        MINE,
        { method: "read", id: "u1" },
        await bearerFor(store, MINE),
      );
      const body = (await res.json()) as { result: { parts: unknown } };
      expect(body.result.parts).toEqual([{ at: 0, bytes: 8 }]);
    });
  });

  describe("with no platform database", () => {
    test("answers 501 — a retry will not make one", async () => {
      // The same answer the enqueue, storage and session-state routes give. The
      // guest reads it once and falls back to its local store, saying so.
      const harness = await createTestOrchestrator();
      await deployAgent(harness.fetch, MINE);
      const res = await callRoute(
        harness.fetch,
        MINE,
        { method: "read", id: "u1" },
        await bearerFor(harness.store, MINE),
      );
      expect(res.status).toBe(501);
    });
  });
});
