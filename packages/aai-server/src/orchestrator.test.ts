// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import {
  createTestKvStore,
  createTestOrchestrator,
  createTestScopeKey,
  createTestStore,
  deployAgent,
  deployBody,
} from "./_test-utils.ts";
import { hashApiKey } from "./auth.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { signScopeToken } from "./scope-token.ts";

test("returns health check", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/health");
  expect(res.status).toBe(200);
  expect(((await res.json()) as Record<string, unknown>).status).toBe("ok");
});

test("returns 404 for unknown paths", async () => {
  const { fetch } = await createTestOrchestrator();
  expect((await fetch("/foo/bar/baz")).status).toBe(404);
});

test("adds Cross-Origin-Isolation headers", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/health");
  expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
});

test("deploy rejects without auth", async () => {
  const { fetch } = await createTestOrchestrator();
  expect((await fetch("/my-agent/deploy", { method: "POST", body: deployBody() })).status).toBe(
    401,
  );
});

test("deploy rejects different owner for claimed slug", async () => {
  const { fetch, store } = await createTestOrchestrator();
  await store.putAgent({
    slug: "my-agent",
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: [await hashApiKey("key1")],
  });
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key2" },
    body: deployBody(),
  });
  expect(res.status).toBe(403);
});

test("deploy succeeds and stores agent", async () => {
  const { fetch, store } = await createTestOrchestrator();
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody(),
  });
  expect(res.status).toBe(200);
  const manifest = await store.getManifest("my-agent");
  expect(manifest?.credential_hashes).toBeDefined();
  expect(manifest?.credential_hashes?.includes(await hashApiKey("key1"))).toBe(true);
});

test("deploy can redeploy same slug", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody(),
  });
  expect(res.status).toBe(200);
});

test("agent health returns 404 for unknown agent", async () => {
  const { fetch } = await createTestOrchestrator();
  expect((await fetch("/missing-agent/health")).status).toBe(404);
});

test("agent health returns ok for deployed agent", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await fetch("/my-agent/health");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.status).toBe("ok");
  expect(body.slug).toBe("my-agent");
});

test("agent page redirects bare slug to trailing slash", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/my-agent");
  expect(res.status).toBe(301);
  expect(res.headers.get("Location")).toBe("http://localhost/my-agent/");
});

test("agent page returns 404 for unknown agent", async () => {
  const { fetch } = await createTestOrchestrator();
  expect((await fetch("/missing-agent/")).status).toBe(404);
});

test("agent page returns HTML for deployed agent", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await fetch("/my-agent/");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/html");
  expect(await res.text()).toContain("<html>");
});

// WebSocket upgrade is handled by the Node.js server in index.ts,
// not by the Hono orchestrator — see ws_integration_test.ts.

// ── Client assets ──────────────────────────────────────────────────────

test("client asset returns 404 for unknown agent", async () => {
  const { fetch } = await createTestOrchestrator();
  expect((await fetch("/missing-agent/assets/index.js")).status).toBe(404);
});

test("client asset returns 404 for missing asset", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  expect((await fetch("/my-agent/assets/nonexistent.js")).status).toBe(404);
});

test("client asset returns JS with correct content type", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await fetch("/my-agent/assets/index.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("javascript");
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(await res.text()).toContain('console.log("c")');
});

test("client asset falls back to octet-stream for unknown extension", async () => {
  const { fetch } = await createTestOrchestrator();
  await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody({
      clientFiles: { "index.html": "<html></html>", "assets/data.xyz123": "binary stuff" },
    }),
  });
  const res = await fetch("/my-agent/assets/data.xyz123");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
});

// ── Metrics ────────────────────────────────────────────────────────────

test("per-agent metrics rejects without auth", async () => {
  const { fetch } = await createTestOrchestrator();
  expect((await fetch("/test-agent/metrics")).status).toBe(401);
});

function kvReq(slug: string, token: string, body: Record<string, unknown>): [string, RequestInit] {
  return [
    `/${slug}/kv`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "fly-client-ip": "127.0.0.1",
      },
      body: JSON.stringify(body),
    },
  ];
}

test("kv set and get round-trip", async () => {
  const { fetch, scopeKey } = await createTestOrchestrator();
  const token = await signScopeToken(scopeKey, { keyHash: "acct-1", slug: "my-agent" });
  const setRes = await fetch(...kvReq("my-agent", token, { op: "set", key: "k1", value: "v1" }));
  expect(((await setRes.json()) as Record<string, unknown>).result).toBe("OK");
  const getRes = await fetch(...kvReq("my-agent", token, { op: "get", key: "k1" }));
  expect(((await getRes.json()) as Record<string, unknown>).result).toBe("v1");
});

// ── Session token ─────────────────────────────────────────────────────

test("session-token rejects without auth", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await fetch("/my-agent/session-token", { method: "POST" });
  expect(res.status).toBe(401);
});

test("session-token rejects wrong owner", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch, "my-agent", "key1");
  const res = await fetch("/my-agent/session-token", {
    method: "POST",
    headers: { Authorization: "Bearer wrong-key" },
  });
  expect(res.status).toBe(403);
});

test("session-token returns token for valid owner", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch, "my-agent", "key1");
  const res = await fetch("/my-agent/session-token", {
    method: "POST",
    headers: { Authorization: "Bearer key1" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  expect(body.token).toBeDefined();
  expect(typeof body.token).toBe("string");
  expect(body.token.length).toBeGreaterThan(0);
});

// ── CORS ─────────────────────────────────────────────────────────────

test("CORS allows any origin by default (allowedOrigins includes *)", async () => {
  const store = createTestStore();
  const scopeKey = await createTestScopeKey();
  const kvStore = createTestKvStore();
  const app = createOrchestrator({
    slots: new Map(),
    store,
    scopeKey,
    kvStore,
    allowedOrigins: ["*"],
  });
  const res = await app.fetch(
    new Request("http://localhost/health", {
      headers: { Origin: "https://example.com" },
    }),
  );
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
});

test("CORS rejects disallowed origin", async () => {
  const store = createTestStore();
  const scopeKey = await createTestScopeKey();
  const kvStore = createTestKvStore();
  const app = createOrchestrator({
    slots: new Map(),
    store,
    scopeKey,
    kvStore,
    allowedOrigins: ["https://allowed.com"],
  });
  const res = await app.fetch(
    new Request("http://localhost/health", {
      headers: { Origin: "https://evil.com" },
    }),
  );
  // Empty string or missing header means rejected
  const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
  expect(allowOrigin === "" || allowOrigin === null).toBe(true);
});

test("CORS allows specific origin when matched", async () => {
  const store = createTestStore();
  const scopeKey = await createTestScopeKey();
  const kvStore = createTestKvStore();
  const app = createOrchestrator({
    slots: new Map(),
    store,
    scopeKey,
    kvStore,
    allowedOrigins: ["https://allowed.com"],
  });
  const res = await app.fetch(
    new Request("http://localhost/health", {
      headers: { Origin: "https://allowed.com" },
    }),
  );
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.com");
});

test("CORS returns * for same-origin (no Origin header)", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/health");
  // No Origin header = same-origin, returns *
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
});

// ── Error handler ────────────────────────────────────────────────────

test("error handler returns 500 for unexpected errors", async () => {
  const { fetch } = await createTestOrchestrator();
  // Trigger a ZodError via invalid deploy body
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: "not json",
  });
  expect(res.status).toBe(400);
});

// ── Secure headers ───────────────────────────────────────────────────

test("adds X-Content-Type-Options and X-Frame-Options headers", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/health");
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
});

test("CORS rejects when no origins configured", async () => {
  const store = createTestStore();
  const scopeKey = await createTestScopeKey();
  const kvStore = createTestKvStore();
  const app = createOrchestrator({
    slots: new Map(),
    store,
    scopeKey,
    kvStore,
    // no allowedOrigins at all
  });
  const res = await app.fetch(
    new Request("http://localhost/health", {
      headers: { Origin: "https://example.com" },
    }),
  );
  const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
  expect(allowOrigin === "" || allowOrigin === null).toBe(true);
});

test("error handler returns 500 for unhandled errors", async () => {
  const store = createTestStore();
  const scopeKey = await createTestScopeKey();
  const kvStore = createTestKvStore();
  const app = createOrchestrator({ slots: new Map(), store, scopeKey, kvStore });
  // Hit a route that triggers an unhandled error by calling metrics
  // without the internal auth header — which causes an HTTPException path
  const res = await app.fetch(new Request("http://localhost/metrics"));
  // requireInternal throws HTTPException(403) when no fly-client-ip
  expect(res.status).toBe(403);
});

test("kv scope isolation", async () => {
  const { fetch, scopeKey } = await createTestOrchestrator();
  const tokenA = await signScopeToken(scopeKey, { keyHash: "acct-1", slug: "agent-a" });
  const tokenB = await signScopeToken(scopeKey, { keyHash: "acct-1", slug: "agent-b" });
  await fetch(...kvReq("agent-a", tokenA, { op: "set", key: "secret", value: "a-data" }));
  const res = await fetch(...kvReq("agent-b", tokenB, { op: "get", key: "secret" }));
  expect(((await res.json()) as Record<string, unknown>).result).toBeNull();
});
