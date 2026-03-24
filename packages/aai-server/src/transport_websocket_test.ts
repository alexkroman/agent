// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { createTestOrchestrator, deployAgent, deployBody } from "./_test_utils.ts";

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

// WebSocket upgrade is handled by the Node.js server in index.ts,
// not by the Hono orchestrator, so it's tested via integration tests.
