// Copyright 2026 the AAI authors. MIT license.
/**
 * A paused upload is picked up where it stopped — the real client against the real
 * router, over a real port.
 *
 * Scenario tier because that pairing is the whole point. Both halves of this were
 * already specced and both were right: `sdk/workflow-upload-parts.test.ts` pins
 * which requests the client issues against a scripted `fetch`, and
 * `workflow-api-uploads.test.ts` pins how the routes answer them against a real
 * router. What neither could see is the AGREEMENT — that the shape the client
 * chooses for a file is one the store can resume — and that is exactly where the
 * bug was: for any file under one part (8 MiB, so most recordings) the client sent
 * a single `PUT`, which the store answers with a 409 the second time because that
 * refusal is what makes a caller-chosen id safe. So resuming re-sent the whole
 * recording from byte zero and was then refused, in a browser, on the one control
 * a person is most likely to press.
 *
 * The socket is really cut, mid-file, which is what a pause is: `_upload-session.ts`
 * aborts the request in flight and the store keeps whatever windows landed.
 *
 * `concurrency: 1` is the only tuning, and it is what makes the assertion an
 * ASSERTION: with the default width every window of a small file is in flight at
 * once on loopback, so the upload finishes before an abort can land anywhere
 * interesting. Serial windows put the cut in a knowable place.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { requestPath } from "../sdk/request-url.ts";
import { UPLOAD_CHUNK_BYTES } from "../sdk/upload-constants.ts";
import { createWorkflowApiClient } from "../sdk/workflow-api-client.ts";
import { rejectingWorkflows } from "../sdk/workflow-unavailable.ts";
import { silentLogger } from "./_test-utils.ts";
import { memoryStore } from "./_upload-store-test-utils.ts";
import { createWorkflowApi } from "./workflow-api.ts";

/** Six windows' worth, and so ONE part at the default size — the case that broke. */
const TOTAL = UPLOAD_CHUNK_BYTES * 6;

/** No run route is exercised here; a workflow call would be the bug. */
const engine = () => ({ ...rejectingWorkflows("no run route here"), listing: () => [] });

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/**
 * The real API over the real store on a loopback port.
 *
 * `sent` counts the bytes each `PUT` DECLARED rather than draining the body: a
 * listener that consumed it would steal the bytes from the route.
 */
async function serve() {
  const { store } = memoryStore();
  const api = createWorkflowApi({ engine, uploads: store, logger: silentLogger });
  const sent = { bytes: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === "PUT") sent.bytes += Number(req.headers["content-length"] ?? 0);
    if (api(req, res, requestPath(req.url), req.method ?? "GET")) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  const { port } = server.address() as AddressInfo;
  return { store, sent, base: `http://127.0.0.1:${port}` };
}

test("a recording cut mid-upload resumes, sending only the windows that are missing", async () => {
  const { store, sent, base } = await serve();
  const client = createWorkflowApiClient({ baseUrl: base });
  const recording = new Blob([new Uint8Array(TOTAL).fill(7)], { type: "audio/wav" });
  const parallel = { concurrency: 1 };

  // The person's pause: the request in flight is aborted, exactly as the gate in
  // `aai-ui/_upload-session.ts` does it.
  const paused = new AbortController();
  const first = client.uploadStream("bbbb", recording, {
    name: "b.wav",
    signal: paused.signal,
    parallel,
  });
  // Cut it once a window has really landed, so there is something to resume and
  // something left to send.
  await vi.waitFor(async () => {
    const info = await store.info("bbbb");
    expect(info?.size).toBeGreaterThanOrEqual(UPLOAD_CHUNK_BYTES);
  });
  paused.abort();
  await expect(first).rejects.toThrow(/abort/i);

  // What the store holds is the contiguous prefix, and it PUBLISHES the windows —
  // which a single `PUT` could not have left behind at all.
  const parked = await store.info("bbbb");
  expect(parked).toMatchObject({ complete: false });
  expect(parked?.ranges?.[0]).toEqual({ start: 0, end: parked?.size });

  const landed = parked?.size ?? 0;
  sent.bytes = 0;
  const stored = await client.uploadStream("bbbb", recording, {
    name: "b.wav",
    resume: true,
    parallel,
  });

  // The upload finishes under its ORIGINAL id — the one a run was started on —
  // and only the tail went back over the wire. Before this it was the whole file
  // followed by `upload bbbb already exists`.
  expect(stored).toMatchObject({ id: "bbbb", size: TOTAL, complete: true });
  expect(sent.bytes).toBe(TOTAL - landed);
  expect(landed).toBeGreaterThan(0);
});
