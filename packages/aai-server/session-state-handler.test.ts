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
import { describe, expect, test } from "vitest";
import {
  bearerFor,
  createTestOrchestrator,
  fakeAdminDbOver,
  type TestFetch,
} from "./test-utils.ts";

const MINE = "mine-agent";
const THEIRS = "theirs-agent";

/** A platform that records the statements and the params it was handed. */
async function platform() {
  const seen: { sql: string; params: unknown[] }[] = [];
  const adminDb = fakeAdminDbOver((sql, params) => {
    seen.push({ sql, params: params ?? [] });
    return sql.includes("coalesce(max(event_index)") ? [{ next: 4 }] : [];
  });
  const harness = await createTestOrchestrator({ adminDb });
  for (const slug of [MINE, THEIRS]) await deploy(harness.fetch, slug);
  return { ...harness, seen };
}

async function deploy(fetch: TestFetch, slug: string): Promise<void> {
  const res = await fetch("/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: JSON.stringify({
      slug,
      env: { ASSEMBLYAI_API_KEY: "k" },
      worker:
        'export default { name: "a", systemPrompt: "p", greeting: "", maxSteps: 1, tools: {} };',
      clientFiles: {},
    }),
  });
  if (!res.ok) throw new Error(`deploy ${slug} answered ${res.status}`);
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

  test("answers 501 with no platform database, because a retry will not make one", async () => {
    const harness = await createTestOrchestrator();
    await deploy(harness.fetch, MINE);
    const res = await callRoute(
      harness.fetch,
      MINE,
      { method: "load", sessionId: "s1" },
      await bearerFor(harness.store, MINE),
    );
    expect(res.status).toBe(501);
  });
});
