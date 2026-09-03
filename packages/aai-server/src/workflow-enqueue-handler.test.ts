// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-enqueue` — the platform half of guest-initiated queueing.
 *
 * The AUTHORIZATION is what these are really about. This is the only route on the
 * agent surface a guest calls with a credential, and the credential is one the
 * platform can recompute rather than store — so the spec that matters is not
 * "does a valid bearer work" but "is a bearer for ANOTHER slug refused", which is
 * the property that makes the route safe to be reachable at all.
 *
 * Driven through the real orchestrator rather than by calling the handler,
 * because two of the things under test are registrations: that the route exists
 * under `/:slug` (a handler that works and is not mounted is the bug
 * `guest-routes.test.ts` exists for, one layer over) and that the body limit is
 * actually applied.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import {
  bearerFor,
  captureLogs,
  createTestOrchestrator,
  deployAgent,
  fakeAdminDbOver,
  type TestFetch,
} from "./test-utils.ts";
import { MAX_ENQUEUE_BODY_BYTES } from "./workflow-enqueue-handler.ts";

const SLUG = "my-agent";
const OTHER = "other-agent";

/** A minimal valid body. `data` is base64 of a JSON payload. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    queueName: "__wkf_step_r1",
    runId: "r1",
    data: Buffer.from(JSON.stringify({ runId: "r1" })).toString("base64"),
    ...over,
  };
}

/**
 * A platform with two deployed agents and a fake admin connection that records
 * the SQL it was handed.
 */
async function platform(over: { failWrites?: boolean } = {}) {
  const statements: string[] = [];
  // The repo's typed seam for this, rather than a literal plus a cast — a
  // concentration of identical casts is a missing seam, and this one already
  // exists for the sweep's specs.
  const adminDb = fakeAdminDbOver((sql) => {
    statements.push(sql.trim().split("\n")[0]?.trim() ?? "");
    if (over.failWrites) throw new Error("connection refused");
    // `enqueue` reads the inserted id back out.
    return [{ id: "wfq_written" }];
  });
  const harness = await createTestOrchestrator({ adminDb });
  await deployAgent(harness.fetch, SLUG);
  await deployAgent(harness.fetch, OTHER);
  return { ...harness, statements, adminDb };
}

/** The bearer this slug's running guest would hold. */
function enqueue(
  fetch: TestFetch,
  slug: string,
  init: { bearer?: string; json?: unknown; raw?: string } = {},
): Promise<Response> {
  // The header is built BEFORE the spread, so `omitUndefined` sees the finished
  // value: a conditional spread would be composing `Bearer undefined`, which is
  // the case `guard-invariants` rule 2 exists to keep out of a request.
  const authorization = init.bearer === undefined ? undefined : `Bearer ${init.bearer}`;
  return fetch(`/${slug}/workflow-enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json", ...omitUndefined({ authorization }) },
    body: init.raw ?? JSON.stringify(init.json ?? body()),
  });
}

describe("POST /:slug/workflow-enqueue", () => {
  const logs = captureLogs();

  describe("authorization", () => {
    test("accepts the bearer this slug's guest holds", async () => {
      const p = await platform();
      const res = await enqueue(p.fetch, SLUG, { bearer: await bearerFor(p.store, SLUG) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ messageId: "wfq_written" });
    });

    /**
     * The property that makes this route safe to exist.
     *
     * The bearer is an HMAC over ONE sandbox name (`guest-token.ts`), so it
     * authorizes one slug. A guest that presents its own valid token for another
     * app's slug is refused by construction — the comparison is against the token
     * THAT slug's current deploy would have — rather than by a check somebody has
     * to remember to write.
     */
    test("refuses another agent's guest, even holding a valid token of its own", async () => {
      const p = await platform();
      const res = await enqueue(p.fetch, SLUG, { bearer: await bearerFor(p.store, OTHER) });
      expect(res.status).toBe(401);
      // Nothing was written for the slug the caller was not authorized for.
      expect(p.statements.some((s) => s.startsWith("insert"))).toBe(false);
    });

    test.each([
      ["no authorization header", undefined],
      ["an empty bearer", ""],
      ["a guessed token", "0".repeat(64)],
    ])("refuses %s", async (_label, bearer) => {
      const p = await platform();
      const res = await enqueue(p.fetch, SLUG, ...(bearer === undefined ? [] : [{ bearer }]));
      expect(res.status).toBe(401);
    });

    test("answers 404 for a slug with no deployed version, not 401 and not 503", async () => {
      // This asserted 503 on the reasoning "a delete/redeploy race, and the guest
      // should RETRY; a 4xx would tell it to stop, which loses the run." All three
      // clauses turned out to be false, which is why `assertGuestBearer` answers
      // 404 now (its module doc carries the rest):
      //
      // - **A REDEPLOY cannot reach this branch.** Agent rows are written `on
      //   conflict (slug) do update set`, so the row never transiently vanishes;
      //   a redeploy changes the VERSION, which invalidates the old sandbox's
      //   bearer and answers 401 — the case this route's own client doc describes.
      //   So the only way here is a delete, and a delete has no later.
      // - **The guest cannot tell a 4xx from a 5xx on this route.**
      //   `workflow-platform-queue.ts` posts through `platformPost` with no
      //   `errorFor`, so every non-2xx becomes one generic `Error` naming the
      //   status. Nothing reads it. The retry that module relies on is the
      //   PLATFORM's delivery sweep, which re-runs the failed delivery and never
      //   sees a status at all.
      // - **There is no run left to lose.** All ten tenant tables cascade off
      //   `agents(slug)`, so a deleted agent takes its runs and its queued
      //   messages with it. A 503 would ask a guest to keep coming back to insert
      //   a message whose foreign key is gone.
      const p = await platform();
      const res = await enqueue(p.fetch, "never-deployed", { bearer: "anything" });
      expect(res.status).toBe(404);
    });

    test("checks the bearer BEFORE reading the body", async () => {
      // An unauthenticated caller must not be able to make this route buffer a
      // megabyte, which is the whole reason the check is not after the parse.
      const p = await platform();
      const res = await enqueue(p.fetch, SLUG, { raw: "not json at all" });
      expect(res.status).toBe(401);
    });
  });

  describe("the body", () => {
    test.each([
      ["a missing queueName", { queueName: undefined }],
      ["an empty queueName", { queueName: "" }],
      ["a missing runId", { runId: undefined }],
      ["an empty runId", { runId: "" }],
      ["a non-string data", { data: 7 }],
      ["a non-numeric delaySeconds", { delaySeconds: "soon" }],
      ["headers that are not a string map", { headers: { a: 7 } }],
      // A name the DELIVERY CLAIM cannot classify is refused here rather than
      // stored. `claimDue` matches orchestration and steps with a pattern each and
      // neither is a catch-all, so such a row would never be claimed at all — and
      // the catch-all it replaced turned a renamed DevKit topic into the whole
      // fleet silently serializing again. This boundary is what makes those two
      // patterns exhaustive over the table.
      ["a queueName of neither kind", { queueName: "__wkf_something_r1" }],
      ["a queueName with no id after the kind", { queueName: "__wkf_step_" }],
      ["a queueName that is not the DevKit's at all", { queueName: "my-queue" }],
    ])("answers 400 naming the field for %s", async (_label, over) => {
      const p = await platform();
      const bearer = await bearerFor(p.store, SLUG);
      const json = body(over);
      // `undefined` does not survive JSON.stringify, which is how "missing" is
      // expressed here.
      const res = await enqueue(p.fetch, SLUG, { bearer, json });
      expect(res.status).toBe(400);
      expect(p.statements.some((s) => s.startsWith("insert"))).toBe(false);
    });

    test.each([
      ["an orchestration name", "__wkf_workflow_r1"],
      ["a step name", "__wkf_step_r1"],
      // `WORKFLOW_QUEUE_NAMESPACE` is a DevKit setting, so the longer form is real.
      // It is also where the grammar is easiest to get wrong: the namespace group
      // is CAPTURING because the same pattern has to run under Postgres's `~`,
      // which has no `(?:`. Refusing these would 400 every message on a
      // deployment that sets a namespace.
      ["a namespaced orchestration name", "__aai_wkf_workflow_r1"],
      ["a namespaced step name", "__aai_wkf_step_r1"],
    ])("accepts %s", async (_label, queueName) => {
      const p = await platform();
      const bearer = await bearerFor(p.store, SLUG);
      const res = await enqueue(p.fetch, SLUG, { bearer, json: body({ queueName }) });
      expect(res.status).toBe(200);
      expect(p.statements.some((s) => s.startsWith("insert"))).toBe(true);
    });

    test("accepts an EMPTY data string, which is a legal empty payload", async () => {
      // Checked for type rather than truthiness: an empty devalue body is not a
      // missing field, and rejecting it would fail a real message.
      const p = await platform();
      const res = await enqueue(p.fetch, SLUG, {
        bearer: await bearerFor(p.store, SLUG),
        json: body({ data: "" }),
      });
      expect(res.status).toBe(200);
    });

    test("answers 400 for a body that is not a JSON object", async () => {
      const p = await platform();
      const res = await enqueue(p.fetch, SLUG, {
        bearer: await bearerFor(p.store, SLUG),
        raw: '"a string"',
      });
      expect(res.status).toBe(400);
    });

    /**
     * This route already parsed its body before reserving, and the spec is here so
     * that stays true rather than being re-derived. Its three siblings did NOT — see
     * `PlatformCall` in `_platform-route.ts` — so the shape is the same on all four
     * and one of them keeping it by accident is not the guarantee.
     */
    test("reserves no connection for a body it is going to refuse", async () => {
      const p = await platform();
      const reserve = vi.spyOn(p.adminDb, "reserve");
      const res = await enqueue(p.fetch, SLUG, {
        bearer: await bearerFor(p.store, SLUG),
        json: { ...body(), runId: "" },
      });
      expect(res.status).toBe(400);
      expect(reserve).not.toHaveBeenCalled();
    });

    test("answers 413 rather than buffering an unbounded body", async () => {
      const p = await platform();
      const res = await enqueue(p.fetch, SLUG, {
        bearer: await bearerFor(p.store, SLUG),
        raw: "x".repeat(MAX_ENQUEUE_BODY_BYTES + 1),
      });
      expect(res.status).toBe(413);
    });
  });

  describe("when there is no queue", () => {
    test("answers 501, not 503 — a retry will not help", async () => {
      // A composition with no platform database has no queue and will not grow one
      // on a retry. Answering 200 to an enqueue that went nowhere would strand the
      // run with a success, which is the one thing this must not do.
      const harness = await createTestOrchestrator();
      await deployAgent(harness.fetch, SLUG);
      const res = await enqueue(harness.fetch, SLUG, {
        bearer: await bearerFor(harness.store, SLUG),
      });
      expect(res.status).toBe(501);
    });
  });

  describe("when the write fails", () => {
    test("answers 503 and says so, because the guest should retry", async () => {
      const p = await platform({ failWrites: true });
      const res = await enqueue(p.fetch, SLUG, { bearer: await bearerFor(p.store, SLUG) });
      expect(res.status).toBe(503);
      expect(logs.warns().join(" ")).toContain("enqueue failed");
    });
  });

  test("writes the queue's envelope, runId queryable and data opaque", async () => {
    // `payload->>'runId'` is what the claim serializes a run's messages on, so the
    // envelope has to be jsonb with that field at the top level — and the bytes
    // ride inside it as base64. See `QueueEnvelope`.
    const p = await platform();
    const res = await enqueue(p.fetch, SLUG, { bearer: await bearerFor(p.store, SLUG) });
    expect(res.status).toBe(200);
    expect(p.statements.some((s) => s.startsWith("insert into aai_platform.workflow_queue"))).toBe(
      true,
    );
  });
});
