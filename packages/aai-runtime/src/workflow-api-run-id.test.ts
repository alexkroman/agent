// Copyright 2026 the AAI authors. MIT license.
/**
 * The run id in a `/workflows/runs/:id` path: what is accepted, and what is
 * answered 400 without ever reaching a store.
 *
 * Split out of `workflow-api.test.ts` at the seam its subject already had —
 * `_workflow-run-id.ts` is one decision and these are its cases — and because
 * that file was at the 700-line cap.
 *
 * Driven through a REAL `node:http` server like its parent, via the shared
 * harness: the whole point of these cases is a RAW request target, which a spec
 * that hands an id to a function does not have.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fakeClient, type Harness, run, serve } from "./workflow-api-test-utils.ts";

let harness: Harness | undefined;

beforeEach(() => {
  harness = undefined;
});

afterEach(async () => {
  await harness?.close();
});

describe("the run id in a path", () => {
  test.each([
    ["GET", "/workflows/runs/%"],
    ["GET", "/workflows/runs/%/events"],
    ["GET", "/workflows/runs/%zz/stream"],
    ["POST", "/workflows/runs/%C0%80/wake"],
    ["DELETE", "/workflows/runs/%A"],
    // A NUL is the one escape that DECODES and is still not a path segment, so
    // it walked straight past the malformed-escape guard and into the store —
    // where Postgres refuses a NUL in text and the router's catch answered 500.
    // Measured under `aai dev`: `GET` and `DELETE /workflows/runs/wrun_%00`
    // both 500, `GET /session-events/tt%00sess` too, and `…/wrun_%00/events`
    // burned its whole read-retry budget before reporting `idle`. Every OTHER
    // control character is ordinary text and 404s correctly.
    ["GET", "/workflows/runs/wrun_%00"],
    ["DELETE", "/workflows/runs/wrun_%00"],
  ])("%s %s is a 400, not a 500", async (method, path) => {
    // A path segment that will not percent-decode is the CALLER's mistake, and
    // the module doc's rule is "400, never 500". Before `decodePathSegment` the
    // URIError escaped `runId` into the router's catch — which reports "the agent
    // is broken", the one thing this could not be.
    const get = vi.fn(async () => run());
    harness = await serve({ engine: () => fakeClient({ get }) });
    const res = await fetch(`${harness.url}${path}`, { method });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Malformed run id" });
    expect(get).not.toHaveBeenCalled();
  });

  test.each([
    ["GET", "/workflows/runs/wrun_%2E%2E%2Fetc"],
    ["GET", "/workflows/runs/wrun_a%2Fb"],
    ["DELETE", "/workflows/runs/wrun_%2E%2E%2Fetc"],
    ["GET", "/workflows/runs/wrun_x%5Cy"],
  ])("%s %s is a 400 — an id no store can take never reaches one", async (method, path) => {
    // These DECODE cleanly, so the guard above passes them through — and the
    // file-backed world `aai dev` runs with no DATABASE_URL then refuses them
    // itself: `Unsafe runId "wrun_../etc": must not be empty, contain ".",
    // "/", "\\", or null bytes`. It refuses correctly (no traversal), but it
    // refuses by THROWING, and the router's catch reports that as
    // `500 Internal server error` — "the agent is broken" for a plainly bad
    // request target. Found by the e2e sweep on its first run; Postgres hid it
    // by having no such rule and simply 404ing.
    //
    // The remedy is the one `uploadIdOr400` already applies next door: check
    // the grammar at the ROUTER, so an id that would escape the store never
    // reaches one, whichever verb asked.
    const get = vi.fn(async () => run());
    harness = await serve({ engine: () => fakeClient({ get }) });
    const res = await fetch(`${harness.url}${path}`, { method });
    expect(res.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });
});
