// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import {
  createTestOrchestrator,
  deployAgent,
  deployBody,
  TEST_AGENT_CONFIG,
} from "./test-utils.ts";

test("returns health check", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok" });
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
  const { hashApiKey } = await import("./secrets.ts");
  await store.putAgent({
    slug: "my-agent",
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: [await hashApiKey("key1")],
    agentConfig: TEST_AGENT_CONFIG,
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
  const { verifyApiKeyHash } = await import("./secrets.ts");
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody(),
  });
  expect(res.status).toBe(200);
  const manifest = await store.getManifest("my-agent");
  expect(manifest?.credential_hashes).toHaveLength(1);
  // biome-ignore lint/style/noNonNullAssertion: toHaveLength(1) above guarantees [0] exists
  expect(await verifyApiKeyHash("key1", manifest!.credential_hashes[0]!)).toBe(true);
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
  expect(await res.json()).toMatchObject({ status: "ok", slug: "my-agent" });
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

test("agent page serves default aai-ui when deployed without client files", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody({ slug: "no-client", clientFiles: {} }),
  });
  expect(res.status).toBe(200);

  const pageRes = await fetch("/no-client/");
  expect(pageRes.status).toBe(200);
  expect(pageRes.headers.get("Content-Type")).toContain("text/html");
  const html = await pageRes.text();
  expect(html).toContain("<!DOCTYPE html>");
  expect(html).toContain('<main id="app"></main>');
});

test("default aai-ui serves JS assets for agents without custom client", async () => {
  const { fetch } = await createTestOrchestrator();
  await fetch("/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody({ slug: "default-assets", clientFiles: {} }),
  });

  // The default HTML references ./assets/index-*.js
  const pageRes = await fetch("/default-assets/");
  const html = await pageRes.text();
  const match = html.match(/src="\.\/assets\/(index-[^"]+\.js)"/);
  expect(match).toBeTruthy();

  // That asset should be served from the default client dist
  const assetRes = await fetch(`/default-assets/assets/${match?.[1]}`);
  expect(assetRes.status).toBe(200);
  expect(assetRes.headers.get("Content-Type")).toContain("javascript");
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

function kvReq(slug: string, apiKey: string, body: Record<string, unknown>): [string, RequestInit] {
  return [
    `/${slug}/kv`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  ];
}

test("kv set and get round-trip", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch, "my-agent");
  const setRes = await fetch(...kvReq("my-agent", "key1", { op: "set", key: "k1", value: "v1" }));
  expect(await setRes.json()).toMatchObject({ result: "OK" });
  const getRes = await fetch(...kvReq("my-agent", "key1", { op: "get", key: "k1" }));
  expect(await getRes.json()).toMatchObject({ result: "v1" });
});

test("kv scope isolation", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch, "agent-aa", "key1");
  await deployAgent(fetch, "agent-bb", "key1");
  await fetch(...kvReq("agent-aa", "key1", { op: "set", key: "secret", value: "a-data" }));
  const res = await fetch(...kvReq("agent-bb", "key1", { op: "get", key: "secret" }));
  expect(await res.json()).toMatchObject({ result: null });
});
