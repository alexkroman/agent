// Copyright 2025 the AAI authors. MIT license.
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { MAX_INFLATED_BODY_BYTES } from "./gzip-request.ts";
import { authHeaders, createTestOrchestrator, deployBody } from "./test-utils.ts";

function gzipHeaders(key = "key1"): Record<string, string> {
  return { ...authHeaders(key), "Content-Encoding": "gzip" };
}

describe("gzip deploy request decompression", () => {
  test("gzipped deploy round-trips: body is inflated, validated, and stored", async () => {
    const { fetch, store } = await createTestOrchestrator();

    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: gzipHeaders(),
      body: new Uint8Array(gzipSync(deployBody())),
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

    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: authHeaders(),
      body: deployBody(),
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

    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: gzipHeaders(),
      body: new Uint8Array(bomb),
    });

    expect(res.status).toBe(413);
  });

  test("invalid gzip bytes are rejected with 400", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: gzipHeaders(),
      body: "definitely not gzip",
    });

    expect(res.status).toBe(400);
  });

  test("unsupported Content-Encoding is rejected with 415", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Encoding": "br" },
      body: deployBody(),
    });

    expect(res.status).toBe(415);
  });
});
