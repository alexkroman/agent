// Copyright 2025 the AAI authors. MIT license.
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import type { HonoEnv } from "./context.ts";
import { createGzipRequestMw, MAX_INFLATED_BODY_BYTES } from "./gzip-request.ts";
import { authHeaders, createTestOrchestrator, deployBody } from "./test-utils.ts";

function gzipHeaders(key = "key1"): Record<string, string> {
  return { ...authHeaders(key), "Content-Encoding": "gzip" };
}

describe("gzip deploy request decompression", () => {
  test("gzipped deploy round-trips: body is inflated, validated, and stored", async () => {
    const { fetch, store } = await createTestOrchestrator();

    const res = await fetch("/deploy", {
      method: "POST",
      headers: gzipHeaders(),
      body: new Uint8Array(gzipSync(deployBody({ slug: "my-agent" }))),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { slug?: string };
    expect(json.slug).toBe("my-agent");

    // The stored worker is the DECOMPRESSED code, byte-identical to what an
    // uncompressed deploy would have stored.
    const worker = await store.getWorkerCode("my-agent");
    expect(worker).toContain('name: "test-agent"');
  });

  test("gzipped top-level deploy (server-generated slug) works too", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/deploy", {
      method: "POST",
      headers: gzipHeaders(),
      body: new Uint8Array(gzipSync(deployBody())),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { slug?: string };
    expect(typeof json.slug).toBe("string");
    expect(json.slug?.length).toBeGreaterThan(0);
  });

  test("uncompressed deploy still works (no Content-Encoding header)", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders(),
      body: deployBody({ slug: "my-agent" }),
    });

    expect(res.status).toBe(200);
  });

  test("body that inflates past the size cap is rejected with 413", async () => {
    const { fetch } = await createTestOrchestrator();

    // A zip bomb: tiny on the wire, > MAX_INFLATED_BODY_BYTES decompressed.
    // The cap is enforced DURING inflation, so this must 413 before any
    // JSON parsing happens.
    const bomb = gzipSync(Buffer.alloc(MAX_INFLATED_BODY_BYTES + 1));
    expect(bomb.byteLength).toBeLessThan(1_000_000);

    const res = await fetch("/deploy", {
      method: "POST",
      headers: gzipHeaders(),
      body: new Uint8Array(bomb),
    });

    expect(res.status).toBe(413);
  });

  test("invalid gzip bytes are rejected with 400", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/deploy", {
      method: "POST",
      headers: gzipHeaders(),
      body: "definitely not gzip",
    });

    expect(res.status).toBe(400);
  });

  test("deploy body over the wire-size cap is rejected with 413 (bodyLimit)", async () => {
    const { fetch } = await createTestOrchestrator();

    // A body larger than MAX_INFLATED_BODY_BYTES: the deploy route's
    // bodyLimit middleware must reject it (via Content-Length) before
    // anything buffers or parses it — so the bytes need only be over the cap,
    // not valid JSON. Sent as bytes rather than a `"x".repeat(cap)` string
    // because that string is UTF-16 in the heap: 240MB to assert on a
    // Content-Length the request never gets to parse.
    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders(),
      body: new Uint8Array(MAX_INFLATED_BODY_BYTES + 1),
    });

    expect(res.status).toBe(413);
  });

  test("unsupported Content-Encoding is rejected with 415", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/deploy", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Encoding": "br" },
      body: deployBody(),
    });

    expect(res.status).toBe(415);
  });
});

// ── Compressed-size cap (unit, injectable cap) ─────────────────────────

describe("compressed body size cap", () => {
  const CAP = 1024;

  function makeApp(): Hono<HonoEnv> {
    const app = new Hono<HonoEnv>();
    app.post("/deploy", createGzipRequestMw(CAP), async (c) => c.json(await c.req.json()));
    return app;
  }

  test("oversized declared Content-Length is rejected with 413", async () => {
    const app = makeApp();
    // An empty stream body: without the Content-Length fast path this would
    // buffer 0 bytes and fail as invalid gzip (400), so a 413 proves the
    // declared size was rejected up front.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const req = new Request("http://localhost/deploy", {
      method: "POST",
      headers: { "Content-Encoding": "gzip", "Content-Length": String(CAP + 1) },
      body,
      duplex: "half",
    });
    const res = await app.request(req);
    expect(res.status).toBe(413);
  });

  test("oversized actual body (no Content-Length) is rejected with 413 while buffering", async () => {
    const app = makeApp();
    // Stream more than the cap without a Content-Length header — the
    // counting reader must bail mid-stream, not buffer it all.
    const chunk = new Uint8Array(512);
    let pushed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed >= CAP * 4) {
          controller.close();
          return;
        }
        pushed += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const req = new Request("http://localhost/deploy", {
      method: "POST",
      headers: { "Content-Encoding": "gzip" },
      body,
      duplex: "half",
    });
    const res = await app.request(req);
    expect(res.status).toBe(413);
    // The reader was cancelled at the cap; the source never drained fully.
    expect(pushed).toBeLessThan(CAP * 4);
  });

  test("a compressed body under the cap still round-trips", async () => {
    const app = makeApp();
    const res = await app.request("/deploy", {
      method: "POST",
      headers: { "Content-Encoding": "gzip", "Content-Type": "application/json" },
      body: new Uint8Array(gzipSync(JSON.stringify({ ok: true }))),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
