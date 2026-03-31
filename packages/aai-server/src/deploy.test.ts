// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { hashApiKey } from "./auth.ts";
import { createTestOrchestrator, deployAgent, deployBody } from "./lib/test-utils.ts";

test("hashApiKey produces consistent hex output", async () => {
  const hash1 = await hashApiKey("test-key");
  const hash2 = await hashApiKey("test-key");
  expect(hash1).toBe(hash2);
  expect(hash1.length).toBe(64);
});

test("deploy rejects invalid JSON body", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: "not json",
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as Record<string, unknown>).error).toBeDefined();
});

test("deploy rejects body missing required fields", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: JSON.stringify({ worker: "" }),
  });
  expect(res.status).toBe(400);
});

test("deploy rejects invalid env (missing ASSEMBLYAI_API_KEY)", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody({ env: { NOT_VALID: "x" } }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as Record<string, unknown>).error).toContain(
    "Invalid platform config",
  );
});

test("deploy merges env with stored env", async () => {
  const { fetch, store } = await createTestOrchestrator();
  await deployAgent(fetch);
  await store.putEnv("my-agent", {
    ASSEMBLYAI_API_KEY: "original-key",
    EXTRA: "stored-value",
  });
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody({ env: { ASSEMBLYAI_API_KEY: "new-key" } }),
  });
  expect(res.status).toBe(200);
  const env = await store.getEnv("my-agent");
  expect(env?.ASSEMBLYAI_API_KEY).toBe("new-key");
  expect(env?.EXTRA).toBe("stored-value");
});

test("deploy replaces existing sandbox on redeploy", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody(),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.ok).toBe(true);
  expect(body.message).toContain("my-agent");
});

test("deploy works without env in body (uses stored env)", async () => {
  const { fetch, store } = await createTestOrchestrator();
  await store.putAgent({
    slug: "pre-stored",
    env: { ASSEMBLYAI_API_KEY: "stored-key" },
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: [await hashApiKey("key1")],
  });
  const res = await fetch("/pre-stored/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: JSON.stringify({
      worker: "console.log('w');",
      clientFiles: { "index.html": "<html></html>" },
    }),
  });
  expect(res.status).toBe(200);
});
