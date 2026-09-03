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
 * `concurrency: 1` is the only tuning, and it puts the windows in a knowable ORDER:
 * with the default width every window of a small file is in flight at once on
 * loopback, so there is no "second window" to speak of.
 *
 * **Order is not the same as timing, and waiting for progress is not a cut.** The
 * first version of this polled `store.info` until a window had landed and then
 * aborted, on the reasoning that serial windows leave something still to send. Six
 * 1 MiB windows into an in-memory store over loopback take a few milliseconds, which
 * is less than `vi.waitFor`'s first sample — so on a fast machine the poll's opening
 * observation was already `size: 6291456, complete: true`, the abort arrived after
 * the upload had resolved, and the spec failed on a green tree. It is a race in
 * either direction: the machine that fails it is the one that is fast enough.
 *
 * So the SERVER holds the second window's `PUT` instead. The cut is then a fact
 * about the test rather than about the host it runs on — exactly one window has
 * landed, one is genuinely in flight, and four have not been sent.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  rejectingWorkflows,
  requestPath,
  UPLOAD_CHUNK_BYTES,
} from "@alexkroman1/aai/host-internal";
import { createWorkflowApiClient } from "@alexkroman1/aai/workflow-api";
import { afterEach, expect, test } from "vitest";
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
 *
 * The SECOND window's `PUT` is held before it reaches the router, and `inFlight`
 * resolves when it arrives. That is what makes the pause deterministic: awaiting it
 * means one window is stored and one is on the wire, whatever the host's speed.
 * Nothing releases the hold — the client's abort is what ends that request, which is
 * what a pause IS.
 */
async function serve() {
  const { store } = memoryStore();
  const api = createWorkflowApi({ engine, uploads: store, logger: silentLogger });
  const sent = { bytes: 0 };
  const arrived = Promise.withResolvers<void>();
  let puts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "PUT") {
      sent.bytes += Number(req.headers["content-length"] ?? 0);
      puts += 1;
      // Held, never answered. The route is not called at all, so this window cannot
      // land — and the request stays open until the abort cuts it.
      if (puts === 2) {
        arrived.resolve();
        return;
      }
    }
    if (api(req, res, requestPath(req.url), req.method ?? "GET")) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // `closeAllConnections` first: the held request above is still open, and
  // `server.close` alone waits for it forever.
  close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  const { port } = server.address() as AddressInfo;
  return { store, sent, inFlight: arrived.promise, base: `http://127.0.0.1:${port}` };
}

test("a recording cut mid-upload resumes, sending only the windows that are missing", async () => {
  const { store, sent, inFlight, base } = await serve();
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
  // Cut it once a window has really landed and the next is really on the wire — a
  // FACT the server establishes, not a duration this test waits out. See `serve`.
  await inFlight;
  expect(await store.info("bbbb")).toMatchObject({ size: UPLOAD_CHUNK_BYTES });
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
