// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
import { expect, test } from "vitest";
import {
  authHeaders,
  createTestOrchestrator,
  deploy,
  deployAgent,
  deployBody,
} from "./test-utils.ts";

test("returns health check", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok" });
});

test("health fails while draining so the platform proxy stops routing here", async () => {
  let draining = false;
  const { fetch } = await createTestOrchestrator({ isDraining: () => draining });
  expect((await fetch("/health")).status).toBe(200);

  draining = true;
  const res = await fetch("/health");
  // 503, not 200-with-a-flag: the status code is the whole mechanism that
  // moves new calls to a machine that is staying up, which is what lets the
  // drain converge instead of racing incoming sessions.
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ status: "draining" });
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
  expect(
    (await fetch("/deploy", { method: "POST", body: deployBody({ slug: "my-agent" }) })).status,
  ).toBe(401);
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
  });
  const res = await deploy(fetch, { key: "key2", body: { slug: "my-agent" } });
  expect(res.status).toBe(403);
});

test("deploy succeeds and stores agent", async () => {
  const { fetch, store } = await createTestOrchestrator();
  const { verifyApiKeyHash } = await import("./secrets.ts");
  const res = await deploy(fetch, { body: { slug: "my-agent" } });
  expect(res.status).toBe(200);
  const record = await store.getAgent("my-agent");
  expect(record?.credential_hashes).toHaveLength(1);
  // biome-ignore lint/style/noNonNullAssertion: toHaveLength(1) above guarantees [0] exists
  expect(await verifyApiKeyHash("key1", record!.credential_hashes[0]!)).toBe(true);
});

test("deploy can redeploy same slug", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await deploy(fetch, { body: { slug: "my-agent" } });
  expect(res.status).toBe(200);
});

test("storage enable on an unclaimed (undeployed) slug is rejected", async () => {
  const { fetch } = await createTestOrchestrator();
  // No agent deployed at this slug → unclaimed. An authenticated caller must
  // not be able to provision storage the eventual owner would inherit.
  const res = await fetch("/never-deployed/storage", {
    method: "POST",
    headers: authHeaders(),
  });
  expect(res.status).toBe(404);
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
  // Relative, so the redirect can never downgrade the scheme: behind a
  // TLS-terminating proxy the request URL is cleartext http, and echoing it
  // back sent an https browser to http:// (and then back again).
  expect(res.headers.get("Location")).toBe("/my-agent/");
});

test("the bare-slug redirect preserves the query string", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/my-agent?sessionId=abc");
  expect(res.status).toBe(301);
  expect(res.headers.get("Location")).toBe("/my-agent/?sessionId=abc");
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
  const res = await deploy(fetch, { body: { slug: "no-client", clientFiles: {} } });
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
  await deploy(fetch, { body: { slug: "default-assets", clientFiles: {} } });

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
  await deploy(fetch, {
    body: {
      slug: "my-agent",
      clientFiles: { "index.html": "<html></html>", "assets/data.xyz123": "binary stuff" },
    },
  });
  const res = await fetch("/my-agent/assets/data.xyz123");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
});

// ── Favicons ───────────────────────────────────────────────────────────

const defaultClientFavicon = path.join(defaultClientDir(), "favicon.ico");

test("agent favicon serves a custom client's stored favicon", async () => {
  const { fetch } = await createTestOrchestrator();
  // Binary client files are stored base64-encoded (isTextAssetPath), so the
  // favicon route must decode — a pass-through would corrupt the bytes.
  const icoBytes = Buffer.from([0x00, 0x00, 0x01, 0x00, 0xff, 0xfe]);
  await deploy(fetch, {
    body: {
      slug: "my-agent",
      clientFiles: { "index.html": "<html></html>", "favicon.ico": icoBytes.toString("base64") },
    },
  });
  const res = await fetch("/my-agent/favicon.ico");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("image/x-icon");
  expect(Buffer.from(await res.arrayBuffer())).toEqual(icoBytes);
});

test("agent favicon falls back to the default client's icon", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  // The fallback reads aai-ui's built default client off disk — the same hard
  // precondition the agent-page specs above assert on. ASSERTED, never branched
  // on: an `if (existsSync(…)) … else expect(404)` moves every run onto the
  // opposite branch, silently, the day an aai-ui build change stops emitting
  // the icon, and the two halves of this file then disagreed about whether the
  // build is a given.
  expect(existsSync(defaultClientFavicon)).toBe(true);

  const res = await fetch("/my-agent/favicon.ico");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("image/x-icon");
  expect(Buffer.from(await res.arrayBuffer())).toEqual(await readFile(defaultClientFavicon));
});
