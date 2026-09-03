// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-journal` as a ROUTE — the door, not the SQL.
 *
 * `platform-workflow-journal.test.ts` covers what the statements look like and
 * `platform-workflow-journal.scenario.test.ts` covers what a real database does
 * with them. What is only visible from here is the five things the handler
 * itself decides. Four of them are ways a durable run silently stops being
 * durable; the fifth is the one way this route can hurt somebody ELSE'S run:
 *
 * - **the BEARER**, which is the whole authorization on this route;
 * - **the SLUG comes from that bearer and never from the body**, which is the
 *   entire tenancy design — a body-supplied slug would make every statement's
 *   `$1` caller-controlled and the column-in-the-key design worthless;
 * - **an unknown method is refused rather than defaulted**, and the offending
 *   value is not echoed back to a tenant;
 * - **no platform database is a 501, not a fallback.** A silent downgrade here is
 *   exactly the failure this route was built to end: a run reporting healthy while
 *   its journal lives in a sandbox that self-exits;
 * - **`listRuns`' page size is BOUNDED here**, and not merely at the runtime
 *   edge that normally sends it. A guest is not trusted — tenant code is one
 *   `fetch` away from this route holding its own bearer — so the ceiling has to
 *   hold with the edge's clamp bypassed entirely, or one tenant decides how much
 *   of a SHARED replica's memory a single request buffers.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { MAX_WORKFLOW_FIND_LIMIT } from "@alexkroman1/aai-runtime";
import { describe, expect, test, vi } from "vitest";
import {
  bearerFor,
  captureLogs,
  createTestOrchestrator,
  deploy,
  fakeAdminDbOver,
  type TestFetch,
} from "./test-utils.ts";
import { MAX_WORKFLOW_JOURNAL_LIST_LIMIT } from "./workflow-journal-handler.ts";

const MINE = "journal-mine";
const THEIRS = "journal-theirs";

/** A platform that records the statements and the params it was handed. */
async function platform(rowsFor?: (sql: string) => Record<string, unknown>[] | undefined) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const adminDb = fakeAdminDbOver((sql, params) => {
    seen.push({ sql, params: params ?? [] });
    const own = rowsFor?.(sql);
    if (own) return own;
    if (sql.includes("returning n")) return [{ n: 1 }];
    return [];
  });
  const harness = await createTestOrchestrator({ adminDb });
  for (const slug of [MINE, THEIRS]) {
    await deploy(harness.fetch, { key: "key1", body: { slug } });
  }
  return { ...harness, seen, adminDb };
}

function callRoute(
  fetch: TestFetch,
  slug: string,
  body: unknown,
  bearer?: string,
  traceparent?: string,
): Promise<Response> {
  const authorization = bearer === undefined ? undefined : `Bearer ${bearer}`;
  return fetch(`/${slug}/workflow-journal`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...omitUndefined({ authorization, traceparent }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// At module scope, because `captureLogs` installs `beforeEach`/`afterEach` —
// called inside a test body it registers its hooks too late to have recorded
// anything.
const logs = captureLogs();

describe("POST /:slug/workflow-journal", () => {
  describe("authorization", () => {
    test("accepts the bearer this agent's guest holds", async () => {
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "readSteps", runId: "wrun_1" },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
    });

    test.each([
      ["no bearer", undefined],
      ["a guessed token", "0".repeat(64)],
    ])("refuses %s", async (_label, bearer) => {
      // The bearer is the ONLY authorization on this route, so this is the whole
      // gate between a tenant's journal and anyone who learns a slug.
      const p = await platform();
      const res = await callRoute(p.fetch, MINE, { method: "readSteps", runId: "wrun_1" }, bearer);
      expect(res.status).toBe(401);
    });

    test("refuses ANOTHER agent's bearer, which is the cross-tenant case", async () => {
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "readSteps", runId: "wrun_1" },
        await bearerFor(p.store, THEIRS),
      );
      expect(res.status).toBe(401);
    });
  });

  describe("the slug comes from the bearer, never from the body", () => {
    test("a body-supplied slug is IGNORED", async () => {
      // The tenancy design is that the slug is `$1` of every statement AND comes
      // from the bearer. If the body could name it, every statement's scope would
      // be caller-controlled and the column-in-the-key design would buy nothing.
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "readSteps", runId: "wrun_1", slug: THEIRS },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
      // Every statement it issued was scoped to the BEARER's agent.
      const scoped = p.seen.filter((entry) => entry.sql.includes("aai_platform.workflow_"));
      expect(scoped.length).toBeGreaterThan(0);
      for (const entry of scoped) expect(entry.params[0]).toBe(MINE);
    });
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
    const p = await platform();
    const reserve = vi.spyOn(p.adminDb, "reserve");
    // `appendStep` with no `entry` — the 400 comes from `stepEntry`, the deepest of
    // this route's twelve field readers.
    const res = await callRoute(
      p.fetch,
      MINE,
      { method: "appendStep", runId: "wrun_1" },
      await bearerFor(p.store, MINE),
    );
    expect(res.status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
  });

  describe("the method", () => {
    test.each([
      "createRun",
      "getRun",
      "listRuns",
      "setStatus",
      "readSteps",
      "readStep",
      "claimAttempt",
      "releaseAttempt",
      "readSleeps",
      "claimSleep",
      "wakeSleeps",
      "claimHook",
      "closeHook",
      "deliverHook",
      "appendStep",
    ])("serves %s", async (method) => {
      // Every method the `JournalStore` seam declares. A method the route does not
      // serve is a guest whose journal silently loses one operation — and the
      // engine's contract has no partial mode.
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        {
          method,
          runId: "wrun_1",
          key: "a#0",
          workflow: "digest",
          status: "pending",
          createdAt: 1,
          limit: 10,
          wakeAt: 1,
          now: 1,
          kind: "sleep",
          token: "tok",
          entry: {
            key: "a#0",
            name: "a",
            status: "ok",
            attempts: 1,
            finishedAt: 1,
          },
        },
        await bearerFor(p.store, MINE),
      );
      // 200 or 500 — a 400 would mean the route rejected the CALL rather than the
      // database answering oddly, which is what a missing method looks like.
      expect(res.status, method).not.toBe(400);
    });

    /**
     * The trace id end to end, over the real route rather than over
     * `withReserved` alone.
     *
     * `_platform-route.test.ts` pins that every line the frame writes carries the
     * id; what only a route can show is that the id is READ — that the header the
     * runtime mints (`aai-runtime/platform-rpc.ts`) reaches `guestTrace` through
     * hono's own request, which is the half a middleware change can break with
     * every unit test still green.
     */
    test("a caller's traceparent reaches the route's own log line", async () => {
      const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
      const p = await platform(() => {
        throw new Error("connection reset");
      });
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "getRun", runId: "wrun_1" },
        await bearerFor(p.store, MINE),
        `00-${TRACE}-00f067aa0ba902b7-01`,
      );
      expect(res.status).toBe(503);
      expect(logs.all().map((line) => line.ctx)).toContainEqual(
        expect.objectContaining({ slug: MINE, traceId: TRACE }),
      );
    });

    test("a refused hook-token claim is a 409 that SAYS why, never a retryable 503", async () => {
      // `withReserved` maps every plain `Error` to 503 — "come back later" — and
      // a token another wait holds cannot change while that wait is alive. So the
      // guest retried a permanent refusal and spent the message's attempt budget
      // on it, against a body reading only `workflow-journal call failed`.
      const p = await platform((sql) =>
        sql.includes("on conflict do nothing")
          ? [{ run_id: "wrun_other", key: "hook!9", token: "tok", delivered: false, closed: false }]
          : undefined,
      );
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "claimHook", runId: "wrun_1", key: "hook!0", token: "tok" },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("hook token already held");
    });

    test("closeHook answers the BOOLEAN, which is what decides the guest's branch", async () => {
      // `null` would read as `false` on the guest side and send every timed-out
      // wait down the answered branch.
      const p = await platform((sql) =>
        sql.includes("select (select count(*) from shut)")
          ? [{ closed: "1", existing: "1" }]
          : undefined,
      );
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "closeHook", runId: "wrun_1", key: "hook!0" },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: true });
    });

    test("refuses an unknown method WITHOUT echoing it back", async () => {
      // The value is caller-supplied and this reply is a tenant's to read.
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "dropEverything" },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("dropEverything");
    });

    test.each([
      ["over the ceiling", MAX_WORKFLOW_JOURNAL_LIST_LIMIT + 1],
      ["a whole history", 1_000_000],
      ["negative", -1],
      ["a non-integer", 2.5],
      ["zero, which no conforming client sends", 0],
    ])("refuses a listRuns limit that is %s, and issues NO statement", async (_label, limit) => {
      // The PLATFORM's own bound, proved without the runtime edge in the picture:
      // this is a raw POST holding a guest bearer, which is exactly what tenant
      // code inside a sandbox can send. `resolveFindLimit` clamps the SDK path and
      // is one `fetch` away from being bypassed, so a handler that trusted it
      // would let one tenant decide how much of a SHARED replica's memory — and
      // one of `ADMIN_POOL_MAX` reserved connections — a single request buffers.
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "listRuns", workflow: "digest", limit },
        await bearerFor(p.store, MINE),
      );
      // 400 and not 503: an out-of-range limit cannot become in-range by waiting,
      // and `withReserved` turns everything it does not recognise into a retry.
      expect(res.status).toBe(400);
      expect(p.seen.filter((entry) => entry.sql.includes("aai_platform.workflow_runs"))).toEqual(
        [],
      );
    });

    test("serves the LARGEST legitimate limit, so the bound is not set past what is reachable", async () => {
      // `MAX_WORKFLOW_FIND_LIMIT` is what `resolveFindLimit` clamps every SDK
      // caller to, so this exact value really does arrive here. A ceiling below it
      // would 400 a request the shipped client produces; one above it is headroom
      // nothing can reach, which is a bound that cannot be observed to work.
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "listRuns", workflow: "digest", limit: MAX_WORKFLOW_JOURNAL_LIST_LIMIT },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(200);
      const listed = p.seen.filter((entry) => entry.sql.includes("aai_platform.workflow_runs"));
      expect(listed).toHaveLength(1);
      expect(listed[0]?.params).toEqual([MINE, "digest", MAX_WORKFLOW_JOURNAL_LIST_LIMIT]);
    });

    test("the ceiling IS the client's clamp, and a change on either side is owed the other", () => {
      // Restated here rather than imported for the reason `TERMINAL` is: this side
      // of the wire takes what arrived over HTTP and polices it itself. Pinned
      // EQUAL rather than `>=` — headroom above the clamp is a limit nothing real
      // reaches, and a clamp above the ceiling 400s a conforming caller.
      expect(MAX_WORKFLOW_JOURNAL_LIST_LIMIT).toBe(MAX_WORKFLOW_FIND_LIMIT);
    });

    test("a listRuns with NO limit is refused rather than defaulted", async () => {
      // A page size the platform invented would be an answer that looks complete
      // and is not, for a caller whose own default (`DEFAULT_WORKFLOW_FIND_LIMIT`)
      // it cannot know. The store contract makes `limit` non-optional; the default
      // belongs at the edge a human types a URL into.
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "listRuns", workflow: "digest" },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(400);
    });

    test("refuses a body that is not a JSON object", async () => {
      const p = await platform();
      const res = await callRoute(p.fetch, MINE, "not json", await bearerFor(p.store, MINE));
      expect(res.status).toBe(400);
    });

    test("refuses a step entry that is not an object", async () => {
      const p = await platform();
      const res = await callRoute(
        p.fetch,
        MINE,
        { method: "appendStep", runId: "wrun_1", entry: "nope" },
        await bearerFor(p.store, MINE),
      );
      expect(res.status).toBe(400);
    });
  });

  test("a stalled reserved query sheds as a 503, and the connection comes BACK", async () => {
    // Every call on this route runs on a RESERVED admin connection, which
    // `createPostgresDb` leaves unbounded by DEFAULT so an advisory-lock wait is
    // never cut short — and this route takes no such lock. Unbounded, four hung
    // reads on a silently partitioned database exhaust `ADMIN_POOL_MAX` and
    // every other platform read on the replica queues behind them. The admin
    // pool now passes `reservedQueryTimeoutMs`, so the stall arrives here as the
    // driver's `QUERY_TIMEOUT`; what this pins is the two things the ROUTE owes
    // it.
    const stalled = Object.assign(new Error("Database query did not complete within 30000ms"), {
      code: "QUERY_TIMEOUT",
    });
    const adminDb = fakeAdminDbOver(() => Promise.reject(stalled));
    const harness = await createTestOrchestrator({ adminDb });
    await deploy(harness.fetch, { key: "key1", body: { slug: MINE } });
    const res = await callRoute(
      harness.fetch,
      MINE,
      { method: "readSteps", runId: "wrun_1" },
      await bearerFor(harness.store, MINE),
    );
    // 503 and not 500: a stall is transient by construction, and the guest's
    // retry is built for "later". `QUERY_TIMEOUT` is in `UNREACHABLE_CODES` for
    // the pooled path's sake; here it is `withReserved`'s catch-all that answers.
    expect(res.status).toBe(503);
    // Asserted, because a deadline that leaks the reservation is the same bug
    // with extra steps — the pool is what the hung reads exhausted.
    expect(adminDb.release).toHaveBeenCalledTimes(1);
  });

  test("answers 501 with NO platform database, rather than falling back", async () => {
    // 501 and not 503: 503 says "later", and there is no later — no platform
    // database means no journal on this deployment, permanently. A FALLBACK would
    // be worse than either, because it is the exact failure this route closes: a
    // run reporting healthy with its journal in a sandbox that self-exits.
    const harness = await createTestOrchestrator({});
    await deploy(harness.fetch, { key: "key1", body: { slug: MINE } });
    const res = await callRoute(
      harness.fetch,
      MINE,
      { method: "readSteps", runId: "wrun_1" },
      await bearerFor(harness.store, MINE),
    );
    expect(res.status).toBe(501);
  });
});
