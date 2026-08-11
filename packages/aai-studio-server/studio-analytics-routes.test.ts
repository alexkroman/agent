// Copyright 2026 the AAI authors. MIT license.
/**
 * The Analytics pane's two HTTP routes, through the real studio app.
 *
 * `studio-analytics.ts` owns the decisions (ownership per slug, the SQL guard,
 * "off" vs "no traffic") and is tested there. What is only visible HERE is the
 * translation into a response, and the two halves of it that a caller depends
 * on and no unit test can see:
 *
 * - a project that does not exist is a 404, while a project with no deployed
 *   agent is a 200 carrying zeroes and an empty `slugs`;
 * - a REFUSED query is a **200 with an `error` string**, not a 4xx. The caller
 *   is an LLM and the refusal is addressed to it ("`pg_` identifiers are not
 *   allowed; select from `events`"); the guest's tool layer turns a non-2xx
 *   into a thrown error whose text the model sees far less reliably. Only a
 *   malformed REQUEST — no `sql` at all — is a 400, because that one is the
 *   caller's bug rather than the model's.
 */

import { createMemoryAnalyticsStore } from "aai-server/analytics-store";
import { authFetch } from "aai-server/test-utils";
import { describe, expect, test } from "vitest";
import { createProject } from "./_studio-routes-test-utils.ts";
import { createTestCombined } from "./_test-combined.ts";

const KEY = "key1";

async function setup(withAnalytics = true) {
  const combined = await createTestCombined(
    withAnalytics ? { analytics: createMemoryAnalyticsStore() } : {},
  );
  await createProject(combined.fetch, "proj", KEY);
  return combined;
}

const summaryOf = (fetch: Awaited<ReturnType<typeof setup>>["fetch"], project = "proj") =>
  authFetch(fetch, `/studio/projects/${project}/analytics`, { method: "GET", key: KEY });

const query = (
  fetch: Awaited<ReturnType<typeof setup>>["fetch"],
  body: unknown,
  project = "proj",
) => authFetch(fetch, `/studio/projects/${project}/analytics/query`, { body, key: KEY });

describe("GET /studio/projects/:project/analytics", () => {
  test("a project with no deployed agent answers 200 with zeroes and no slugs", async () => {
    const { fetch } = await setup();
    const res = await summaryOf(fetch);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slugs: string[]; sessions: { count: number } };
    expect(body.slugs).toEqual([]);
    expect(body.sessions.count).toBe(0);
  });

  test("a project that does not exist is a 404", async () => {
    const { fetch } = await setup();
    expect((await summaryOf(fetch, "no-such-project")).status).toBe(404);
  });

  test("a deployment with analytics switched off says so rather than showing zeroes", async () => {
    // The two states must never look alike: zeroes for a disabled feature tell
    // a user their agent has no users.
    const { fetch } = await setup(false);
    const res = await summaryOf(fetch);
    expect(res.status).toBe(200);
    expect((await res.json()) as { unavailable?: string }).toMatchObject({
      unavailable: expect.stringMatching(/not enabled/i),
    });
  });

  test("requires a bearer", async () => {
    const { fetch } = await setup();
    expect((await fetch("/studio/projects/proj/analytics")).status).toBe(401);
  });
});

describe("POST /studio/projects/:project/analytics/query", () => {
  test("a refused statement is a 200 the MODEL can read, not a 4xx", async () => {
    const { fetch } = await setup();
    const res = await query(fetch, { sql: "select * from pg_authid" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { error?: string }).toMatchObject({
      error: expect.stringMatching(/pg_/),
    });
  });

  test("a malformed REQUEST is still a 400 — that one is the caller's bug", async () => {
    const { fetch } = await setup();
    expect((await query(fetch, {})).status).toBe(400);
    expect((await query(fetch, { sql: "" })).status).toBe(400);
  });

  test("an over-large limit is accepted and clamped, never refused", async () => {
    // The guest's tool description promises "clamped server-side"; a 400 here
    // reaches the model as an opaque `HTTP 400` it cannot act on.
    const { fetch } = await setup();
    const res = await query(fetch, { sql: "select count(*) from events", limit: 999_999 });
    expect(res.status).toBe(200);
  });

  test("a project with no deployed agent answers an empty result, not an error", async () => {
    const { fetch } = await setup();
    const res = await query(fetch, { sql: "select count(*) from events" });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      slugs: [],
      columns: [],
      rows: [],
      truncated: false,
    });
  });

  test("a project that does not exist is a 404", async () => {
    const { fetch } = await setup();
    const res = await query(fetch, { sql: "select 1 from events" }, "no-such-project");
    expect(res.status).toBe(404);
  });

  test("analytics switched off is reported to the model, not thrown", async () => {
    const { fetch } = await setup(false);
    const res = await query(fetch, { sql: "select 1 from events" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { error?: string }).toMatchObject({
      error: expect.stringMatching(/not enabled/i),
    });
  });

  test("requires a bearer", async () => {
    const { fetch } = await setup();
    const res = await fetch("/studio/projects/proj/analytics/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "select 1 from events" }),
    });
    expect(res.status).toBe(401);
  });
});
