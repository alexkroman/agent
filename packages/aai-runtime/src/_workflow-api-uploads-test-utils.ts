// Copyright 2026 the AAI authors. MIT license.
/**
 * The loopback server and the in-memory store the upload-route specs run against.
 *
 * Shared by `workflow-api-uploads.test.ts` (the whole-file writes and the reads) and
 * `workflow-api-uploads-parts.test.ts` (the `/parts` pair), which were one file until
 * it went past the test-file line cap. The split is by ROUTE GROUP; the harness is
 * the same one, so a fake that drifts cannot make the two halves disagree about what
 * a store does.
 *
 * Each test file registers `afterEach(closeServer)` itself — an `afterEach` declared
 * here would attach to whichever suite happened to import it first.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { rejectingWorkflows, requestPath } from "@alexkroman1/aai/internal";
import type { UploadInfo } from "@alexkroman1/aai/step";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { silentLogger } from "./_test-utils.ts";
import { createWorkflowApi } from "./workflow-api.ts";
import {
  assertPartOffset,
  contiguousBytes,
  rangesOf,
  UnknownUploadError,
  type UploadPart,
  UploadPartError,
  type UploadStore,
} from "./workflow-uploads.ts";

/** An engine that answers nothing: these routes must not touch it. */
export const engine = () => ({
  ...rejectingWorkflows("no run route is exercised here"),
  listing: () => [],
});

let close: (() => Promise<void>) | undefined;
/**
 * The store the last {@link serve} built.
 *
 * Only the DIRECT-path specs need it: `recordParts` carries no body, so the only way to
 * say "these bytes are in the bucket" is to put them where the store looks.
 */
let lastStore: ReturnType<typeof fakeStore> | undefined;

/** The store behind the running server, for a spec that has to seed stored bytes. */
export function current(): ReturnType<typeof fakeStore> {
  if (!lastStore) throw new Error("no store: serve() was called with an explicit uploads");
  return lastStore;
}
/** Shut the running server down. Each suite registers this as its own `afterEach`. */
export async function closeServer(): Promise<void> {
  await close?.();
  close = undefined;
}

/** Mount the API over an in-memory store on a real loopback server. */
export async function serve(
  opts: { uploads?: UploadStore | undefined; directParts?: boolean } = {},
): Promise<string> {
  // `"uploads" in opts` rather than a default parameter: a default is applied
  // for an explicit `undefined` too, which is exactly the case the "no store"
  // spec below needs to reach.
  const built = "uploads" in opts ? opts.uploads : fakeStore();
  lastStore = built && "stored" in built ? (built as ReturnType<typeof fakeStore>) : undefined;
  const uploads = built;
  // The shared no-op logger, not a module-level bag of `vi.fn()`s: nothing
  // here asserts on log output, and a spy singleton is what lets a later
  // `toHaveBeenCalled` pass on an earlier test's call.
  const api = createWorkflowApi({
    engine,
    uploads,
    logger: silentLogger,
    ...omitUndefined({ directParts: opts.directParts }),
  });
  const server = http.createServer((req, res) => {
    const url = requestPath(req.url);
    if (api(req, res, url, req.method ?? "GET")) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A store the ROUTES can be driven against — enough to exercise create + range. */
export function fakeStore(): UploadStore & { stored: Map<string, Uint8Array> } {
  // `size` is tracked beside the buffer rather than read off it: a PARTS upload is
  // allocated whole at its declaration, so its buffer's length is the file's total
  // from the first moment and its `size` is the contiguous prefix.
  const files = new Map<
    string,
    { name: string; type: string; bytes: Uint8Array; size: number; complete: boolean }
  >();
  let seq = 0;
  // What a PARTS upload declared, and which windows have landed. Kept beside the
  // bytes rather than in them, because a parts upload's `size` is the contiguous
  // prefix and its buffer is the whole file from the moment it is begun.
  const totals = new Map<string, number>();
  const parts = new Map<string, UploadPart[]>();
  /**
   * Bytes a spec says are ALREADY in the bucket, keyed `<id>/<offset>`.
   *
   * The direct path's whole premise: `recordParts` carries no body, so the only thing
   * that can tell a real part from a claimed one is asking the store. This map is
   * what the fake asks.
   */
  const stored = new Map<string, Uint8Array>();
  /** One part's arrival, however its bytes got here. */
  const record = (id: string, offset: number, bytes: number) => {
    const file = files.get(id);
    const total = totals.get(id) ?? 0;
    const merged = [
      ...(parts.get(id) ?? []).filter((one) => one.at !== offset),
      { at: offset, bytes },
    ];
    parts.set(id, merged);
    const size = contiguousBytes(rangesOf(merged));
    if (file) {
      file.size = size;
      file.complete = size >= total;
    }
    return {
      id,
      name: file?.name ?? "",
      type: file?.type ?? "",
      size,
      complete: file?.complete ?? false,
    };
  };

  /** Drain a request body, which both writers do the same way. */
  const drain = async (body: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const piece of body) {
      parts.push(piece);
      size += piece.length;
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return bytes;
  };
  return {
    async create(meta, body) {
      const bytes = await drain(body);
      const id = `upl_${++seq}`;
      files.set(id, {
        name: meta.name ?? "",
        type: meta.type ?? "",
        bytes,
        size: bytes.length,
        complete: true,
      });
      return {
        id,
        name: meta.name ?? "",
        type: meta.type ?? "",
        size: bytes.length,
        complete: true,
      };
    },
    async stream(id, meta, body) {
      // The real store refuses a taken id — a fake that did not would let the
      // route's 409 be tested against a path production does not take.
      if (files.has(id)) {
        const { UploadIdTakenError } = await import("./workflow-uploads.ts");
        throw new UploadIdTakenError(id);
      }
      const name = meta.name ?? "";
      const type = meta.type ?? "";
      // Present from the first byte, which is the property this route exists for.
      files.set(id, { name, type, bytes: new Uint8Array(0), size: 0, complete: false });
      const bytes = await drain(body);
      files.set(id, { name, type, bytes, size: bytes.length, complete: true });
      return { id, name, type, size: bytes.length, complete: true };
    },
    async beginParts(id, meta, total) {
      if (files.has(id)) {
        const { UploadIdTakenError } = await import("./workflow-uploads.ts");
        throw new UploadIdTakenError(id);
      }
      const name = meta.name ?? "";
      const type = meta.type ?? "";
      // The real store allocates nothing up front either — what exists from here
      // is the RECORD, which is the property the route is for.
      files.set(id, { name, type, bytes: new Uint8Array(total), size: 0, complete: false });
      totals.set(id, total);
      parts.set(id, []);
      return { id, name, type, size: 0, complete: false };
    },
    async writePart(id, offset, body) {
      // The same two refusals the real store makes, spelled through the same
      // helpers — a fake that accepted a misaligned part would let the route's
      // 400 be tested against a path production does not take.
      assertPartOffset(offset);
      const file = files.get(id);
      const total = totals.get(id);
      if (!file || total === undefined) throw new UnknownUploadError(id);
      const bytes = await drain(body);
      if (offset + bytes.length > total) {
        throw new UploadPartError(`A part at ${offset} runs past the ${total} bytes declared.`);
      }
      file.bytes.set(bytes, offset);
      return record(id, offset, bytes.length);
    },
    async recordParts(id, offsets) {
      // The direct path: the bytes went to the bucket without passing through the
      // agent, so the store measures them ITSELF. The fake stands in for the
      // measurement with what a spec put there — `stored` below.
      //
      // Measured in FULL before anything is written, like the real store: a batch
      // holding one bad offset must record none of itself, and a fake that wrote as
      // it went would let a spec pass over a half-recorded batch.
      const measured = offsets.map((offset) => {
        assertPartOffset(offset);
        const file = files.get(id);
        if (!file) throw new UnknownUploadError(id);
        const bytes = stored.get(`${id}/${offset}`);
        if (bytes === undefined) {
          throw new UploadPartError(`No bytes are stored for the part at ${offset}.`);
        }
        return { file, offset, bytes };
      });
      let last: UploadInfo | undefined;
      for (const { file, offset, bytes } of measured) {
        file.bytes.set(bytes, offset);
        last = record(id, offset, bytes.length);
      }
      // `recordParts` refuses an empty list, so the loop always ran.
      if (!last) throw new UploadPartError(`A claim on upload ${id} named no parts.`);
      return last;
    },
    async info(id) {
      const file = files.get(id);
      return file
        ? { id, name: file.name, type: file.type, size: file.size, complete: file.complete }
        : undefined;
    },
    // The fake's whole record is one `Map` entry, so `open` is `info` plus a bound
    // reader and buys nothing here — which is exactly the shape the real store's
    // version has and the reason the count is only measurable against a home that
    // is a round trip away (`upload-record-round-trips.test.ts`).
    async open(id) {
      const file = files.get(id);
      if (!file) return;
      return {
        info: { id, name: file.name, type: file.type, size: file.size, complete: file.complete },
        read: async (start, end) => file.bytes.subarray(start, end),
      };
    },
    async read(id, start, end) {
      return files.get(id)?.bytes.subarray(start, end) ?? new Uint8Array(0);
    },
    stored,
  };
}

/**
 * What `POST /workflows/uploads` answers with, as a spec reads it.
 *
 * Named rather than inlined so the `res.json()` below can narrow to IT — the cast
 * used to be `as never`, which is assignable to everything and therefore stops
 * reporting the moment this shape and the route's answer disagree.
 */
type Stored = { id: string; name: string; type: string; size: number; url: string };

/** Store one file and answer with what the route said about it. */
export async function upload(
  base: string,
  bytes: Uint8Array,
  init: { name?: string; type?: string } = {},
): Promise<Stored> {
  const res = await fetch(`${base}/workflows/uploads?name=${encodeURIComponent(init.name ?? "")}`, {
    method: "POST",
    headers: { "Content-Type": init.type ?? "application/octet-stream" },
    body: bytes,
  });
  // Thrown rather than asserted: this helper runs outside the test body, where
  // an `expect` would be a misplaced assertion — and a failure here is setup
  // that did not happen, not a claim that did not hold.
  if (res.status !== 201) throw new Error(`upload failed: HTTP ${res.status}`);
  return (await res.json()) as Stored;
}
