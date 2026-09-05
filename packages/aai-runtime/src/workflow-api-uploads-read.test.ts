// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the upload READ routes, and for the read-ahead under the bytes one.
 *
 * Driven through a real `node:http` server for the reason
 * `workflow-api-uploads.test.ts` gives — half of what this route decides IS HTTP.
 * The status-code and `Range` cases live in that suite, beside the writes they
 * share a harness with; what is here is the thing that suite cannot see, which is
 * WHEN the store is asked for a chunk relative to the socket the answer goes out
 * on.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { UPLOAD_CHUNK_BYTES } from "@alexkroman1/aai/host-internal";
import { rejectingWorkflows, requestPath } from "@alexkroman1/aai/internal";
import type { UploadInfo } from "@alexkroman1/aai/step";
import { afterEach, describe, expect, test, vi } from "vitest";
import { silentLogger, tick } from "./_test-utils.ts";
import { createWorkflowApi } from "./workflow-api.ts";
import { UPLOAD_READ_AHEAD } from "./workflow-api-uploads-read.ts";
import type { UploadStore } from "./workflow-uploads.ts";

/** An engine that answers nothing: these routes must not touch it. */
const engine = () => ({
  ...rejectingWorkflows("no run route is exercised here"),
  listing: () => [],
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A counter's value once it has stopped moving. */
async function settledCount(count: () => number): Promise<number> {
  for (;;) {
    const before = count();
    await tick();
    if (count() === before) return before;
  }
}

/** The chunk a read of `[start, end)` should answer with, by its position. */
function chunkByte(start: number): number {
  return (start / UPLOAD_CHUNK_BYTES) % 251;
}

/**
 * A store that holds no bytes and SYNTHESIZES them, one gated read at a time.
 *
 * The file is a dozen megabytes and every chunk is one value, so a spec can say
 * "this is chunk seven" without either side holding the file. The gate is what
 * makes the claim observable: reads park until the spec opens it, so "eight are in
 * flight" is a fact rather than a race.
 */
function gatedReadStore(size: number): UploadStore & {
  reads: number[];
  /** How many times the RECORD was resolved — see the route's `open` note. */
  lookups: () => number;
  release: () => void;
} {
  const gate = Promise.withResolvers<void>();
  const reads: number[] = [];
  let released = false;
  let lookups = 0;
  const refuse = (): never => {
    throw new Error("this suite reads; the write routes are specced beside the writes");
  };
  const record = (id: string): UploadInfo | undefined => {
    lookups += 1;
    return id === "upl_read"
      ? { id, name: "a.wav", type: "audio/wav", size, complete: true }
      : undefined;
  };
  const bytes = async (start: number, end: number): Promise<Uint8Array> => {
    reads.push(start);
    if (!released) await gate.promise;
    return new Uint8Array(end - start).fill(chunkByte(start));
  };
  return {
    reads,
    lookups: () => lookups,
    release: () => {
      released = true;
      gate.resolve();
    },
    info: (id) => Promise.resolve(record(id)),
    open: (id) => {
      const info = record(id);
      return Promise.resolve(info && { info, read: bytes });
    },
    async read(_id, start, end) {
      return await bytes(start, end);
    },
    create: refuse,
    stream: refuse,
    beginParts: refuse,
    writePart: refuse,
    recordParts: refuse,
  };
}

/** Mount the API over one store on a real loopback server. */
async function serve(uploads: UploadStore): Promise<string> {
  const api = createWorkflowApi({ engine, uploads, logger: silentLogger });
  const server = http.createServer((req, res) => {
    const url = requestPath(req.url);
    if (api(req, res, url, req.method ?? "GET")) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /workflows/uploads/:id", () => {
  test("reads ahead of the socket instead of a round trip per chunk", async () => {
    // The claim: a chunk is fetched while earlier chunks are still being written,
    // so a download is not a couple of hundred round trips laid end to end. Read
    // one at a time, this store would have been asked exactly once.
    const store = gatedReadStore(UPLOAD_CHUNK_BYTES * 12);
    const base = await serve(store);
    const answered = fetch(`${base}/workflows/uploads/upl_read`);
    await vi.waitFor(() => expect(store.reads.length).toBe(UPLOAD_READ_AHEAD));
    // Asserted against the constant AND against one, because the constant is what
    // the route uses: a width of 1 would satisfy the line above while being exactly
    // the sequential walk this replaced.
    expect(UPLOAD_READ_AHEAD).toBeGreaterThan(1);

    // In order, and no further than the window: the file is twelve chunks.
    expect(store.reads).toEqual(
      Array.from({ length: UPLOAD_READ_AHEAD }, (_, at) => at * UPLOAD_CHUNK_BYTES),
    );
    store.release();
    const res = await answered;
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toHaveLength(UPLOAD_CHUNK_BYTES * 12);
    expect(store.reads).toHaveLength(12);
  });

  test("resolves the record ONCE for the whole download, not once per chunk", async () => {
    // The other half of "a download is not a couple of hundred round trips": the
    // read-ahead above bounded the BYTE reads, and every one of them used to resolve
    // the record for itself as well — `store.read(id, …)` takes an id, so the store
    // has to look the row up before it can say which object holds a byte. On a
    // deployed guest that row is a `POST /:slug/upload-records` across the platform,
    // so a twelve-megabyte download was thirteen of them.
    const store = gatedReadStore(UPLOAD_CHUNK_BYTES * 12);
    store.release();
    const base = await serve(store);
    const res = await fetch(`${base}/workflows/uploads/upl_read`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toHaveLength(UPLOAD_CHUNK_BYTES * 12);
    // Twelve chunks were read and the record was resolved once. Asserted against
    // the chunk count too, so a route that went back to a look-up per chunk fails
    // here rather than merely getting slower.
    expect(store.reads).toHaveLength(12);
    expect(store.lookups()).toBe(1);
  });

  test("writes the chunks in file order however the reads settle", async () => {
    // What read-ahead must not cost: `mapStream` yields in source order, so a chunk
    // that came back early cannot overtake the one before it. Every chunk carries
    // its own index as its bytes, so a swap is visible at the boundary.
    const store = gatedReadStore(UPLOAD_CHUNK_BYTES * 12);
    store.release();
    const base = await serve(store);
    const res = await fetch(`${base}/workflows/uploads/upl_read`);
    const body = new Uint8Array(await res.arrayBuffer());
    const boundaries = Array.from({ length: 12 }, (_, at) => body[at * UPLOAD_CHUNK_BYTES]);
    expect(boundaries).toEqual(Array.from({ length: 12 }, (_, at) => at % 251));
    // And the last byte, so a short final chunk cannot pass by being absent.
    expect(body.at(-1)).toBe(11 % 251);
  });

  test("stops reading when the client hangs up mid-download", async () => {
    // A window of reads may be in flight when the socket dies; what must not happen
    // is the route walking the rest of the file into a socket nobody is on.
    const store = gatedReadStore(UPLOAD_CHUNK_BYTES * 200);
    store.release();
    const base = await serve(store);
    const aborter = new AbortController();
    const res = await fetch(`${base}/workflows/uploads/upl_read`, { signal: aborter.signal });
    await res.body?.getReader().read();
    aborter.abort();
    // Poll until the count STOPS moving rather than sampling it once: a route that
    // kept walking would satisfy any single reading taken early enough.
    const stopped = await settledCount(() => store.reads.length);
    expect(stopped).toBeGreaterThan(0);
    // 200 is what an unbounded walk reaches; the window's width past wherever the
    // socket died is what a bounded one does.
    expect(stopped).toBeLessThan(200);
  });
});
