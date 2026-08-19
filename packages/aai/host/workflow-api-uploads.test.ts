// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the two upload routes.
 *
 * Driven through a real `node:http` server for the reason `workflow-api.test.ts`
 * gives — half of what these routes decide IS HTTP, and here that is the whole
 * of the second one: a 206 with a `Content-Range` a client can place, a 416 for
 * a window outside the file, and a plain 200 for a request that named no range.
 *
 * The `parseRange` unit tests below sit beside them because the header has
 * three legal spellings and one of them (`bytes=-N`) means the opposite end of
 * the file from what it looks like.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { UPLOAD_CHUNK_BYTES } from "../sdk/constants.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { requestPath } from "../sdk/request-url.ts";
import { rejectingWorkflows } from "../sdk/workflow-unavailable.ts";
import { silentLogger } from "./_test-utils.ts";
import { createWorkflowApi } from "./workflow-api.ts";
import { parseRange } from "./workflow-api-uploads.ts";
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
const engine = () => ({
  ...rejectingWorkflows("no run route is exercised here"),
  listing: () => [],
});

let close: (() => Promise<void>) | undefined;
/**
 * The store the last {@link serve} built.
 *
 * Only the DIRECT-path specs need it: `recordPart` carries no body, so the only way to
 * say "these bytes are in the bucket" is to put them where the store looks.
 */
let lastStore: ReturnType<typeof fakeStore> | undefined;

/** The store behind the running server, for a spec that has to seed stored bytes. */
function current(): ReturnType<typeof fakeStore> {
  if (!lastStore) throw new Error("no store: serve() was called with an explicit uploads");
  return lastStore;
}
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** Mount the API over an in-memory store on a real loopback server. */
async function serve(
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
function fakeStore(): UploadStore & { stored: Map<string, Uint8Array> } {
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
   * The direct path's whole premise: `recordPart` carries no body, so the only thing
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
    async recordPart(id, offset) {
      // The direct path: the bytes went to the bucket without passing through the
      // agent, so the store measures them ITSELF. The fake stands in for the
      // measurement with what a spec put there — `stored` below.
      assertPartOffset(offset);
      const file = files.get(id);
      const total = totals.get(id);
      if (!file || total === undefined) throw new UnknownUploadError(id);
      const bytes = stored.get(`${id}/${offset}`);
      if (bytes === undefined) {
        throw new UploadPartError(`No bytes are stored for the part at ${offset}.`);
      }
      file.bytes.set(bytes, offset);
      return record(id, offset, bytes.length);
    },
    async info(id) {
      const file = files.get(id);
      return file
        ? { id, name: file.name, type: file.type, size: file.size, complete: file.complete }
        : undefined;
    },
    async read(id, start, end) {
      return files.get(id)?.bytes.subarray(start, end) ?? new Uint8Array(0);
    },
    stored,
  };
}

/** Store one file and answer with what the route said about it. */
async function upload(
  base: string,
  bytes: Uint8Array,
  init: { name?: string; type?: string } = {},
): Promise<{ id: string; name: string; type: string; size: number; url: string }> {
  const res = await fetch(`${base}/workflows/uploads?name=${encodeURIComponent(init.name ?? "")}`, {
    method: "POST",
    headers: { "Content-Type": init.type ?? "application/octet-stream" },
    body: bytes,
  });
  // Thrown rather than asserted: this helper runs outside the test body, where
  // an `expect` would be a misplaced assertion — and a failure here is setup
  // that did not happen, not a claim that did not hold.
  if (res.status !== 201) throw new Error(`upload failed: HTTP ${res.status}`);
  return (await res.json()) as never;
}

describe("POST /workflows/uploads", () => {
  test("stores the body and answers with the handle a run input carries", async () => {
    const base = await serve();
    const stored = await upload(base, new Uint8Array([1, 2, 3]), {
      name: "standup.wav",
      type: "audio/wav",
    });
    expect(stored).toMatchObject({ name: "standup.wav", type: "audio/wav", size: 3 });
    expect(stored.url).toBe(`/workflows/uploads/${stored.id}`);
  });

  test("drops the charset off the declared type — it describes the request", async () => {
    const base = await serve();
    const stored = await upload(base, new Uint8Array([1]), { type: "text/csv; charset=utf-8" });
    expect(stored.type).toBe("text/csv");
  });

  test("answers 413 for a body past the cap rather than storing a short file", async () => {
    const base = await serve({
      uploads: {
        ...fakeStore(),
        create: async () => {
          const { UploadTooLargeError } = await import("./workflow-uploads.ts");
          throw new UploadTooLargeError(10);
        },
      },
    });
    const res = await fetch(`${base}/workflows/uploads`, { method: "POST", body: "too much" });
    expect(res.status).toBe(413);
  });

  test("404s with the fix on a server that stores no uploads", async () => {
    const base = await serve({ uploads: undefined });
    const res = await fetch(`${base}/workflows/uploads`, { method: "POST", body: "x" });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("stores no uploads"),
    });
  });
});

describe("GET /workflows/uploads/:id", () => {
  test("answers the whole file when no range is asked for", async () => {
    const base = await serve();
    const stored = await upload(base, new Uint8Array([1, 2, 3, 4]), { type: "audio/wav" });
    const res = await fetch(`${base}${stored.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  test("answers 206 with a Content-Range a client can place", async () => {
    const base = await serve();
    const stored = await upload(base, new Uint8Array([1, 2, 3, 4, 5]));
    const res = await fetch(`${base}${stored.url}`, { headers: { Range: "bytes=1-3" } });
    expect(res.status).toBe(206);
    // Inclusive, unlike everything else here: `1-3` of 5 bytes is three bytes.
    expect(res.headers.get("content-range")).toBe("bytes 1-3/5");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([2, 3, 4]);
  });

  test("names the file, so a browser download is not called by its id", async () => {
    const base = await serve();
    const stored = await upload(base, new Uint8Array([1]), { name: "standup.wav" });
    const res = await fetch(`${base}${stored.url}`);
    expect(res.headers.get("content-disposition")).toContain('filename="standup.wav"');
    await res.arrayBuffer();
  });

  test("a filename with a control character still downloads", async () => {
    // The uploader owns that string. `\x01` is not a response-splitting risk, so
    // the old CR/LF/quote strip let it through — and Node rejects EVERY control
    // character in a header value, so `res.writeHead` threw `ERR_INVALID_CHAR`
    // and this upload was a 500 on every read, permanently, with the bytes fine
    // in the store the whole time.
    const base = await serve();
    const stored = await upload(base, new Uint8Array([1]), { name: "a\u0001b.wav" });
    const res = await fetch(`${base}${stored.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="ab.wav"');
    // The real name survives on the half that can carry it.
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''a%01b.wav");
    await res.arrayBuffer();
  });

  test("a non-ASCII filename rides on filename* rather than breaking the header", async () => {
    const base = await serve();
    const stored = await upload(base, new Uint8Array([1]), { name: "café.wav" });
    const res = await fetch(`${base}${stored.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent("café.wav")}`,
    );
    await res.arrayBuffer();
  });

  test("answers 416 for a window outside the file", async () => {
    const base = await serve();
    const stored = await upload(base, new Uint8Array([1, 2, 3]));
    const res = await fetch(`${base}${stored.url}`, { headers: { Range: "bytes=99-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */3");
  });

  test("404s on an id that names no upload", async () => {
    const base = await serve();
    const res = await fetch(`${base}/workflows/uploads/upl_gone`);
    expect(res.status).toBe(404);
  });
});

describe("parseRange", () => {
  test("reads a closed range as [start, end)", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 10 });
  });

  test("reads an open-ended range to the end of the file", () => {
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 100 });
  });

  test("reads a suffix range from the END", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 100 });
  });

  test("caps a suffix longer than the file at the whole file", () => {
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 100 });
  });

  test("caps an end past the file rather than refusing it", () => {
    expect(parseRange("bytes=90-999", 100)).toEqual({ start: 90, end: 100 });
  });

  test("reports a start past the file as unsatisfiable", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
  });

  test("IGNORES a header it cannot parse, so the whole file is the answer", () => {
    // RFC 9110: an unparsable range is ignored, which is a legal answer — only
    // a parsable one outside the file is a 416.
    expect(parseRange("items=0-1", 100)).toBeUndefined();
    expect(parseRange("bytes=0-1, 5-6", 100)).toBeUndefined();
    expect(parseRange("bytes=-", 100)).toBeUndefined();
  });
});

describe("PUT /workflows/uploads/:id", () => {
  test("stores under the caller's own id, so a run can be started on it first", async () => {
    const base = await serve();
    const res = await fetch(`${base}/workflows/uploads/abc123?name=standup.wav`, {
      method: "PUT",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(201);
    // The id is the caller's, which is the whole difference from the POST: it
    // existed before the bytes left, so it can already be in a run input.
    await expect(res.json()).resolves.toMatchObject({
      id: "abc123",
      name: "standup.wav",
      size: 3,
      complete: true,
    });
  });

  test("a second PUT to one id is a 409, never an append", async () => {
    const base = await serve();
    const put = () =>
      fetch(`${base}/workflows/uploads/abc123`, { method: "PUT", body: new Uint8Array([1]) });
    expect((await put()).status).toBe(201);
    // The safety argument for letting a caller choose the id.
    expect((await put()).status).toBe(409);
  });

  test("an id that would escape the store is a 400", async () => {
    const base = await serve();
    const res = await fetch(`${base}/workflows/uploads/..%2Fescape`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
  });

  test("a malformed percent-escape in the id is a 400, never a 500", async () => {
    const base = await serve();
    const res = await fetch(`${base}/workflows/uploads/%`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /workflows/uploads/:id/info", () => {
  test("reports the record rather than the bytes", async () => {
    const base = await serve();
    const stored = await upload(base, new Uint8Array([1, 2, 3]), { name: "a.wav" });
    const res = await fetch(`${base}/workflows/uploads/${stored.id}/info`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: stored.id,
      name: "a.wav",
      type: "application/octet-stream",
      size: 3,
      complete: true,
    });
  });

  test("is matched BEFORE `/uploads/:id`, which is a prefix rule", async () => {
    const base = await serve();
    const stored = await upload(base, new Uint8Array([1, 2, 3]));
    // Listed the other way round this reads `"<id>/info"` as an upload id and 404s
    // an upload that plainly exists — the same trap as `/runs/:id/events`.
    const res = await fetch(`${base}/workflows/uploads/${stored.id}/info`);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("404s for an id nothing stored", async () => {
    const base = await serve();
    const res = await fetch(`${base}/workflows/uploads/upl_gone/info`);
    expect(res.status).toBe(404);
  });
});

describe("the parts routes", () => {
  /** Declare an upload its parts will fill in, and answer what the route said. */
  async function begin(
    base: string,
    id: string,
    total: number,
    init: { name?: string; type?: string } = {},
  ): Promise<Response> {
    return await fetch(
      `${base}/workflows/uploads/${id}/parts?name=${encodeURIComponent(init.name ?? "")}&total=${total}`,
      { method: "POST", headers: { "Content-Type": init.type ?? "application/octet-stream" } },
    );
  }

  /** Send one window of it. */
  async function part(
    base: string,
    id: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<Response> {
    return await fetch(`${base}/workflows/uploads/${id}/parts?offset=${offset}`, {
      method: "PUT",
      body: bytes,
    });
  }

  /** A chunk of bytes whose CONTENT identifies where it came from. */
  function ramp(n: number, from = 0): Uint8Array {
    return Uint8Array.from({ length: n }, (_, at) => (from + at) % 251);
  }

  test("declares an upload readable before a single part has landed", async () => {
    const base = await serve();
    const res = await begin(base, "abc", UPLOAD_CHUNK_BYTES * 2, {
      name: "standup.wav",
      type: "audio/wav",
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      id: "abc",
      name: "standup.wav",
      type: "audio/wav",
      size: 0,
      complete: false,
      url: "/workflows/uploads/abc",
    });
  });

  test("says nothing about a direct byte route by default", async () => {
    // `aai dev` and a self-hosted server hold the bucket credential themselves and
    // serve no such route. The field is OMITTED rather than `false`, because that is
    // also what an agent deployed before any of this existed answers — one shape for
    // "send the body to me", not two.
    const base = await serve();
    const res = await begin(base, "abc", 8);
    await expect(res.json()).resolves.not.toHaveProperty("directParts");
  });

  test("advertises the direct route when the deployment has one", async () => {
    // A CAPABILITY of the deployment, answered by the claim so a client never has to
    // guess it from its own URL — a wrong guess sends megabytes into a 404.
    const base = await serve({ directParts: true });
    const res = await begin(base, "abc", 8);
    await expect(res.json()).resolves.toMatchObject({ directParts: true });
  });

  test("`stored=1` records a window without carrying it", async () => {
    // The direct path's write. No body: the bytes went to the platform, and the store
    // measures the object itself rather than trusting anything here.
    const base = await serve({ directParts: true });
    await begin(base, "abc", 8);
    const store = current();
    store.stored.set("abc/0", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const res = await fetch(`${base}/workflows/uploads/abc/parts?offset=0&stored=1`, {
      method: "PUT",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ size: 8, complete: true });
  });

  test("`stored=1` is a 400 for a window nobody uploaded", async () => {
    // The whole defence on that path: a client claiming a part it never sent would
    // advance `size` over bytes that are not there, and a step reading them gets
    // SILENCE — a gap in a transcript with nothing anywhere reporting one.
    const base = await serve({ directParts: true });
    await begin(base, "abc", 8);
    const res = await fetch(`${base}/workflows/uploads/abc/parts?offset=0&stored=1`, {
      method: "PUT",
    });
    expect(res.status).toBe(400);
  });

  test("reassembles parts sent AT ONCE and out of order", async () => {
    const base = await serve();
    const total = UPLOAD_CHUNK_BYTES * 3;
    await begin(base, "abc", total);
    // All three in flight together, which is the shape the client really sends —
    // and `Promise.all` settles them in whatever order the server finishes.
    const answers = await Promise.all([
      part(base, "abc", UPLOAD_CHUNK_BYTES * 2, ramp(UPLOAD_CHUNK_BYTES, 2)),
      part(base, "abc", 0, ramp(UPLOAD_CHUNK_BYTES)),
      part(base, "abc", UPLOAD_CHUNK_BYTES, ramp(UPLOAD_CHUNK_BYTES, 1)),
    ]);
    expect(answers.map((one) => one.status)).toEqual([200, 200, 200]);
    const stored = await fetch(`${base}/workflows/uploads/abc/info`);
    await expect(stored.json()).resolves.toMatchObject({ size: total, complete: true });
    // Read across a seam, so this is about the ORDER of the bytes rather than
    // their number.
    const bytes = await fetch(`${base}/workflows/uploads/abc`, {
      headers: { Range: `bytes=${UPLOAD_CHUNK_BYTES - 1}-${UPLOAD_CHUNK_BYTES}` },
    });
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([
      (UPLOAD_CHUNK_BYTES - 1) % 251,
      1,
    ]);
  });

  test("answers each part with the record AS IT NOW STANDS", async () => {
    const base = await serve();
    await begin(base, "abc", UPLOAD_CHUNK_BYTES * 2);
    // The part that closes the last gap tells its own sender the upload is
    // finished, so a client never has to poll for it.
    const first = await part(base, "abc", 0, ramp(UPLOAD_CHUNK_BYTES));
    await expect(first.json()).resolves.toMatchObject({
      size: UPLOAD_CHUNK_BYTES,
      complete: false,
    });
    const last = await part(base, "abc", UPLOAD_CHUNK_BYTES, ramp(UPLOAD_CHUNK_BYTES));
    await expect(last.json()).resolves.toMatchObject({
      size: UPLOAD_CHUNK_BYTES * 2,
      complete: true,
    });
  });

  test("a declaration with no total is a 400 naming what is missing", async () => {
    const base = await serve();
    const res = await fetch(`${base}/workflows/uploads/abc/parts`, { method: "POST" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("total") });
  });

  test("a part with no offset is a 400 naming what is missing", async () => {
    const base = await serve();
    await begin(base, "abc", UPLOAD_CHUNK_BYTES);
    const res = await fetch(`${base}/workflows/uploads/abc/parts`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("offset") });
  });

  test("a misaligned offset is a 400, not a part stored in the wrong place", async () => {
    const base = await serve();
    await begin(base, "abc", UPLOAD_CHUNK_BYTES);
    const res = await part(base, "abc", 7, ramp(4));
    // 400 rather than a retryable status, because the request will be refused
    // identically every time and a client retrying it is in a loop.
    expect(res.status).toBe(400);
  });

  test("a part for an upload nobody declared is a 404", async () => {
    const base = await serve();
    const res = await part(base, "abc", 0, ramp(4));
    expect(res.status).toBe(404);
  });

  test("a second declaration of one id is a 409, never a re-declaration", async () => {
    const base = await serve();
    await begin(base, "abc", UPLOAD_CHUNK_BYTES);
    expect((await begin(base, "abc", UPLOAD_CHUNK_BYTES)).status).toBe(409);
  });

  test("an id that would escape the store is a 400", async () => {
    const base = await serve();
    const res = await fetch(`${base}/workflows/uploads/..%2Fescape/parts?total=4`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  test("is matched BEFORE `/uploads/:id`, which is a prefix rule", async () => {
    const base = await serve();
    // The order-is-load-bearing rule: listed the other way round, this `PUT` reads
    // `"abc/parts"` as an upload id and stores a whole file under it.
    await begin(base, "abc", UPLOAD_CHUNK_BYTES);
    expect((await part(base, "abc", 0, ramp(UPLOAD_CHUNK_BYTES))).status).toBe(200);
    const stored = await fetch(`${base}/workflows/uploads/abc%2Fparts/info`);
    expect(stored.status).toBe(404);
  });

  test("404s with the fix on a server that stores no uploads", async () => {
    const base = await serve({ uploads: undefined });
    expect((await begin(base, "abc", 4)).status).toBe(404);
    expect((await part(base, "abc", 0, ramp(4))).status).toBe(404);
  });
});
