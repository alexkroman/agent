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
import { afterEach, describe, expect, test, vi } from "vitest";
import { requestPath } from "../sdk/request-url.ts";
import { rejectingWorkflows } from "../sdk/workflow-unavailable.ts";
import { createWorkflowApi } from "./workflow-api.ts";
import { parseRange } from "./workflow-api-uploads.ts";
import type { UploadStore } from "./workflow-uploads.ts";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

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

/** Mount the API over an in-memory store on a real loopback server. */
async function serve(opts: { uploads?: UploadStore | undefined } = {}): Promise<string> {
  // `"uploads" in opts` rather than a default parameter: a default is applied
  // for an explicit `undefined` too, which is exactly the case the "no store"
  // spec below needs to reach.
  const uploads = "uploads" in opts ? opts.uploads : memoryStore();
  const api = createWorkflowApi({ engine, uploads, logger });
  const server = http.createServer((req, res) => {
    const url = requestPath(req.url);
    if (api(req, res, url, req.method ?? "GET")) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The real store over an in-memory `Db` — enough to exercise create + range. */
function memoryStore(): UploadStore {
  const files = new Map<string, { name: string; type: string; bytes: Uint8Array }>();
  let seq = 0;
  return {
    async create(meta, body) {
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
      const id = `upl_${++seq}`;
      files.set(id, { name: meta.name ?? "", type: meta.type ?? "", bytes });
      return { id, name: meta.name ?? "", type: meta.type ?? "", size };
    },
    async info(id) {
      const file = files.get(id);
      return file ? { id, name: file.name, type: file.type, size: file.bytes.length } : undefined;
    },
    async read(id, start, end) {
      return files.get(id)?.bytes.subarray(start, end) ?? new Uint8Array(0);
    },
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
        ...memoryStore(),
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
