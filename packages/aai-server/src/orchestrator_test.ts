// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { createTestOrchestrator, deployAgent, deployBody } from "./_test_utils.ts";
import { hashApiKey } from "./auth.ts";
import { signScopeToken } from "./scope_token.ts";

test("returns health check", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/health");
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("ok");
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
  const body = await res.json();
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
// not by the Hono orchestrator.

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
  expect((await setRes.json()).result).toBe("OK");
  const getRes = await fetch(...kvReq("my-agent", token, { op: "get", key: "k1" }));
  expect((await getRes.json()).result).toBe("v1");
});

test("kv scope isolation", async () => {
  const { fetch, scopeKey } = await createTestOrchestrator();
  const tokenA = await signScopeToken(scopeKey, { keyHash: "acct-1", slug: "agent-a" });
  const tokenB = await signScopeToken(scopeKey, { keyHash: "acct-1", slug: "agent-b" });
  await fetch(...kvReq("agent-a", tokenA, { op: "set", key: "secret", value: "a-data" }));
  const res = await fetch(...kvReq("agent-b", tokenB, { op: "get", key: "secret" }));
  expect((await res.json()).result).toBeNull();
});
