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

import { afterEach, describe, expect, test } from "vitest";
import { closeServer, fakeStore, serve, upload } from "./_workflow-api-uploads-test-utils.ts";
import { parseRange } from "./workflow-api-uploads-read.ts";

afterEach(closeServer);

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

  test("400s for an id that is not one, naming the grammar — never a 500", async () => {
    // The reads used to hand a bad id straight to the store, whose `assertUploadToken`
    // throws a plain `Error` that `sendUploadFailure` cannot classify — so the router's
    // catch answered `500 Internal server error` and put the reason in the log only.
    // The same mistake on `POST …/parts` answered 400 and explained itself, which is
    // exactly the "a client must be able to tell its own bad request from a broken
    // agent" rule split across two statuses.
    const base = await serve();
    for (const path of ["/workflows/uploads/not..valid/info", "/workflows/uploads/not..valid"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining("1-64 characters"),
      });
    }
  });

  test("a well-formed id nothing stored is still a 404, not a 400", async () => {
    // The grammar check must not swallow the case it sits in front of: a server-minted
    // id that has simply been reclaimed is a different answer from a malformed one.
    const base = await serve();
    const res = await fetch(`${base}/workflows/uploads/upl_deadbeef`);
    expect(res.status).toBe(404);
    await res.text();
  });
});
