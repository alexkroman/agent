// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-journal` as a ROUTE — the door, not the SQL.
 *
 * `platform-workflow-journal.test.ts` covers what the statements look like and
 * `platform-workflow-journal.scenario.test.ts` covers what a real database does
 * with them. What is only visible from here is the four things the handler itself
 * decides, and each is a way a durable run silently stops being durable:
 *
 * - **the BEARER**, which is the whole authorization on this route;
 * - **the SLUG comes from that bearer and never from the body**, which is the
 *   entire tenancy design — a body-supplied slug would make every statement's
 *   `$1` caller-controlled and the column-in-the-key design worthless;
 * - **an unknown method is refused rather than defaulted**, and the offending
 *   value is not echoed back to a tenant;
 * - **no platform database is a 501, not a fallback.** A silent downgrade here is
 *   exactly the failure this route was built to end: a run reporting healthy while
 *   its journal lives in a sandbox that self-exits.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import {
  bearerFor,
  createTestOrchestrator,
  deploy,
  fakeAdminDbOver,
  type TestFetch,
} from "./test-utils.ts";

const MINE = "journal-mine";
const THEIRS = "journal-theirs";

/** A platform that records the statements and the params it was handed. */
async function platform() {
  const seen: { sql: string; params: unknown[] }[] = [];
  const adminDb = fakeAdminDbOver((sql, params) => {
    seen.push({ sql, params: params ?? [] });
    if (sql.includes("returning n")) return [{ n: 1 }];
    return [];
  });
  const harness = await createTestOrchestrator({ adminDb });
  for (const slug of [MINE, THEIRS]) {
    await deploy(harness.fetch, { key: "key1", body: { slug } });
  }
  return { ...harness, seen };
}

function callRoute(
  fetch: TestFetch,
  slug: string,
  body: unknown,
  bearer?: string,
): Promise<Response> {
  const authorization = bearer === undefined ? undefined : `Bearer ${bearer}`;
  return fetch(`/${slug}/workflow-journal`, {
    method: "POST",
    headers: { "content-type": "application/json", ...omitUndefined({ authorization }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

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

  describe("the method", () => {
    test.each([
      "createRun",
      "getRun",
      "listRuns",
      "setStatus",
      "readSteps",
      "claimAttempt",
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
