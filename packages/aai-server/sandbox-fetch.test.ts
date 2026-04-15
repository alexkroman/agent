// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for sandbox-fetch.ts
 *
 * Uses a local HTTP test server for real fetch testing via node:http.
 * skipSsrf: true + 127.0.0.1 in allowedHosts to allow loopback in tests.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createFetchHandler,
  type FetchRequest,
  type FetchResponseChunk,
  type FetchResponseEnd,
  type FetchResponseError,
  type FetchResponseMessage,
  type FetchResponseStart,
} from "./sandbox-fetch.ts";

// ── Test server setup ──────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/echo-headers") {
      // Echo back the Authorization header for inspection
      const authHeader = req.headers.authorization ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ authorization: authHeader }));
      return;
    }

    if (pathname === "/large") {
      // 8 KB response
      const chunk = Buffer.alloc(8 * 1024, "x");
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(chunk);
      return;
    }

    if (pathname === "/slow") {
      // Delay to allow concurrent test to queue up
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("slow response");
      }, 50);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello from test server");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function collectMessages(
  handler: ReturnType<typeof createFetchHandler>,
  req: FetchRequest,
  id: string,
): Promise<FetchResponseMessage[]> {
  const msgs: FetchResponseMessage[] = [];
  return handler(req, id, (msg) => msgs.push(msg)).then(() => msgs);
}

function makeReq(url: string, overrides: Partial<FetchRequest> = {}): FetchRequest {
  return {
    url,
    method: "GET",
    headers: {},
    body: null,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("createFetchHandler: host allowlist", () => {
  test("blocks request to host not in allowedHosts", async () => {
    const handler = createFetchHandler({
      allowedHosts: ["api.example.com"],
      skipSsrf: true,
    });

    const msgs = await collectMessages(handler, makeReq(`${baseUrl}/`), "r1");
    expect(msgs).toHaveLength(1);
    const err = msgs[0] as FetchResponseError;
    expect(err.type).toBe("fetch/response-error");
    expect(err.id).toBe("r1");
    expect(err.message).toMatch(/not allowed/i);
  });

  test("blocks request when allowedHosts is empty", async () => {
    const handler = createFetchHandler({
      allowedHosts: [],
      skipSsrf: true,
    });

    const msgs = await collectMessages(handler, makeReq(`${baseUrl}/`), "r2");
    expect(msgs).toHaveLength(1);
    const err = msgs[0] as FetchResponseError;
    expect(err.type).toBe("fetch/response-error");
    expect(err.id).toBe("r2");
    expect(err.message).toMatch(/not allowed/i);
  });
});

describe("createFetchHandler: successful fetch", () => {
  test("allows request to allowed host and returns chunked response", async () => {
    const handler = createFetchHandler({
      allowedHosts: ["127.0.0.1"],
      skipSsrf: true,
    });

    const msgs = await collectMessages(handler, makeReq(`${baseUrl}/`), "r3");

    // Should have at minimum: response-start, at least one chunk, response-end
    const start = msgs.find((m) => m.type === "fetch/response-start") as
      | FetchResponseStart
      | undefined;
    const chunks = msgs.filter((m) => m.type === "fetch/response-chunk") as FetchResponseChunk[];
    const end = msgs.find((m) => m.type === "fetch/response-end") as FetchResponseEnd | undefined;

    expect(start).toBeDefined();
    expect(start?.id).toBe("r3");
    expect(start?.status).toBe(200);
    expect(end).toBeDefined();
    expect(end?.id).toBe("r3");
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Decode all chunks and check content
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c.data, "base64"))).toString("utf8");
    expect(body).toBe("hello from test server");
  });
});

describe("createFetchHandler: response size cap", () => {
  test("emits error when response exceeds maxResponseBytes", async () => {
    const handler = createFetchHandler({
      allowedHosts: ["127.0.0.1"],
      skipSsrf: true,
      maxResponseBytes: 100, // 100 bytes — the 8 KB response will exceed this
    });

    const msgs = await collectMessages(handler, makeReq(`${baseUrl}/large`), "r4");

    // Should end with an error message
    const err = msgs.find((m) => m.type === "fetch/response-error") as
      | FetchResponseError
      | undefined;
    expect(err).toBeDefined();
    expect(err?.id).toBe("r4");
    expect(err?.message).toMatch(/response.*exceeded|exceeded.*limit|too large/i);
  });
});

describe("createFetchHandler: concurrency limit", () => {
  test("enforces maxConcurrent limit", async () => {
    const handler = createFetchHandler({
      allowedHosts: ["127.0.0.1"],
      skipSsrf: true,
      maxConcurrent: 2,
    });

    // Fire 3 concurrent requests — one should fail immediately with an error
    const results = await Promise.all([
      collectMessages(handler, makeReq(`${baseUrl}/slow`), "c1"),
      collectMessages(handler, makeReq(`${baseUrl}/slow`), "c2"),
      collectMessages(handler, makeReq(`${baseUrl}/slow`), "c3"),
    ]);

    const errors = results.filter((msgs) => msgs.some((m) => m.type === "fetch/response-error"));
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // The error should be about concurrency
    const concurrencyError = errors
      .flat()
      .find((m) => m.type === "fetch/response-error") as FetchResponseError;
    expect(concurrencyError.message).toMatch(/concurrent|limit/i);
  });
});

describe("createFetchHandler: request headers", () => {
  test("passes through request headers including Authorization", async () => {
    const handler = createFetchHandler({
      allowedHosts: ["127.0.0.1"],
      skipSsrf: true,
    });

    const req = makeReq(`${baseUrl}/echo-headers`, {
      headers: { Authorization: "Bearer test-token-123" },
    });
    const msgs = await collectMessages(handler, req, "r5");

    const chunks = msgs.filter((m) => m.type === "fetch/response-chunk") as FetchResponseChunk[];
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c.data, "base64"))).toString("utf8");
    const parsed = JSON.parse(body) as { authorization: string };
    expect(parsed.authorization).toBe("Bearer test-token-123");
  });
});

describe("createFetchHandler: wildcard patterns", () => {
  test("wildcard pattern matching allows subdomain", async () => {
    const handler = createFetchHandler({
      allowedHosts: ["*.example.com"],
      skipSsrf: true,
      // Override fetch to avoid network call — we just want to test hostname matching
      fetchFn: async () => new Response("ok", { status: 200 }),
    });

    const msgs = await collectMessages(
      handler,
      makeReq("https://api.example.com/v1/endpoint"),
      "r6",
    );

    // Should NOT be blocked — api.example.com matches *.example.com
    const err = msgs.find((m) => m.type === "fetch/response-error") as
      | FetchResponseError
      | undefined;
    // If there is an error, it should NOT be a "not allowed" error
    if (err) {
      expect(err.message).not.toMatch(/not allowed/i);
    } else {
      // No error — successfully fetched
      const end = msgs.find((m) => m.type === "fetch/response-end");
      expect(end).toBeDefined();
    }
  });

  test("wildcard pattern does not match base domain itself", async () => {
    const handler = createFetchHandler({
      allowedHosts: ["*.example.com"],
      skipSsrf: true,
      fetchFn: async () => new Response("ok", { status: 200 }),
    });

    const msgs = await collectMessages(handler, makeReq("https://example.com/"), "r7");

    const err = msgs.find((m) => m.type === "fetch/response-error") as
      | FetchResponseError
      | undefined;
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/not allowed/i);
  });
});

describe("createFetchHandler: invalid URL", () => {
  test("emits error for invalid URL", async () => {
    const handler = createFetchHandler({
      allowedHosts: ["example.com"],
      skipSsrf: true,
    });

    const msgs = await collectMessages(handler, makeReq("not-a-valid-url"), "r8");
    expect(msgs).toHaveLength(1);
    const err = msgs[0] as FetchResponseError;
    expect(err.type).toBe("fetch/response-error");
    expect(err.id).toBe("r8");
  });
});
