// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the upload routes of a deployment that has no upload backend.
 *
 * Its own file rather than another block in `workflow-api-uploads.test.ts`, which
 * is at its line cap — and the split is the right one anyway: every spec here is
 * about ONE store (`createUnavailableUploadStore`) and one question, which is
 * whether an operator can tell what is wrong from the outside. The neighbouring
 * file is about what the routes do when they work.
 *
 * The condition is not the neighbour's `uploads: undefined`, which is "no store, so
 * the routes are not mounted" and answers 404. `installWorkflowSupport` ALWAYS
 * builds a store, and `createUploadStore` returns the refusing one for the one pairing
 * is missing, so the routes are mounted and every call reaches a method that
 * rejects. That is what a deployed agent with no database or no bucket really is,
 * and all of them used to answer `{"error":"Internal server error"}`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { RETRYABLE_STATUS } from "@alexkroman1/aai/host-internal";
import { rejectingWorkflows, requestPath } from "@alexkroman1/aai/internal";
import { afterEach, describe, expect, test } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { createWorkflowApi } from "./workflow-api.ts";
import { createUnavailableUploadStore } from "./workflow-uploads.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** The API over a store that refuses everything, on a real loopback server. */
// The one combination that really refuses: a database with no bucket behind it.
async function serveUnavailable(
  missing = "somewhere to put the bytes (`AAI_UPLOAD_STORAGE_URL`)",
): Promise<string> {
  const api = createWorkflowApi({
    engine: () => ({
      ...rejectingWorkflows("no run route is exercised here"),
      listing: () => [],
    }),
    uploads: createUnavailableUploadStore(missing),
    logger: silentLogger,
  });
  const server = http.createServer((req, res) => {
    if (api(req, res, requestPath(req.url), req.method ?? "GET")) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("a deployment whose upload store is UNAVAILABLE", () => {
  // Distinct from `uploads: undefined` above, which is "no store, so no routes" and
  // answers 404. Here the routes ARE mounted — `installWorkflowSupport` always builds
  // a store, and `createUploadStore` returns the refusing one for the one combination
  // it cannot serve: a DATABASE with nowhere durable for the bytes. (No database at
  // all is not this case; it takes the local world's directory, which is what
  // `workflow-uploads.test.ts` covers.) It used to answer
  // `{"error":"Internal server error"}` on all of them.
  const unavailable = () => serveUnavailable();

  test("a write answers 501 and NAMES what the deployment is missing", async () => {
    const base = await unavailable();
    const res = await fetch(`${base}/workflows/uploads`, { method: "POST", body: "x" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("somewhere to put the bytes");
    // The remedy, which is the entire reason this message is worth a status of its
    // own — an operator reading it needs no access to the guest's logs. The `.env`
    // block is the whole of it: what a half-configured deployment is missing is the
    // durable byte store, and these are the keys that name one.
    expect(body.error).toContain("AAI_UPLOAD_STORAGE_URL=");
    expect(body.error).toContain("supabase status -o env");
  });

  test("the parts claim answers 501 too, not the 409 a taken id gets", async () => {
    const base = await unavailable();
    const res = await fetch(`${base}/workflows/uploads/abc/parts?total=4`, { method: "POST" });
    expect(res.status).toBe(501);
  });

  test("GET …/info answers 501 rather than 404 or 500", async () => {
    // The route a person reaches for to ask why the others are failing, and the one
    // that read `store.info` outside any `try`. A 404 here would be the worst of the
    // three answers: it says "your id is wrong" about a deployment that can hold no
    // ids at all.
    const base = await unavailable();
    const res = await fetch(`${base}/workflows/uploads/abc/info`);
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("a database"),
    });
  });

  test("GET …/:id answers 501 rather than streaming a body", async () => {
    const base = await unavailable();
    const res = await fetch(`${base}/workflows/uploads/abc`);
    expect(res.status).toBe(501);
  });

  test("the status is one the client will NOT retry", () => {
    // The load-bearing half, and a property of two modules at once: under any status
    // in this set a client spends its whole `UPLOAD_PART_ATTEMPTS` budget per part
    // re-asking a deployment that cannot ever answer differently, and the operator's
    // message arrives last, looking like a flaky link. 500 and 503 are both in it.
    expect(RETRYABLE_STATUS.has(501)).toBe(false);
    expect(RETRYABLE_STATUS.has(500)).toBe(true);
  });
});
