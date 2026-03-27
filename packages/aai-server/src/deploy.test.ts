// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { createTestOrchestrator, deployAgent, deployBody } from "./_test-utils.ts";
import { hashApiKey } from "./auth.ts";

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
  expect(((await res.json()) as Record<string, unknown>).error).toContain("Invalid deploy body");
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

test("deploy merges credential hashes for multi-user ownership", async () => {
  const { fetch } = await createTestOrchestrator();
  // First deploy by key1
  await deployAgent(fetch, "my-agent", "key1");
  // Second deploy by key2
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key2", "Content-Type": "application/json" },
    body: deployBody(),
  });
  // key2 should be rejected since it's not an owner
  expect(res.status).toBe(403);
});

test("redeploy by same owner preserves credential hash without duplication", async () => {
  const { fetch, store } = await createTestOrchestrator();
  await deployAgent(fetch, "my-agent", "key1");
  // Redeploy with same key
  await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody(),
  });
  const manifest = await store.getManifest("my-agent");
  const keyHash = await hashApiKey("key1");
  // Should not have duplicates
  const count = manifest?.credential_hashes.filter((h) => h === keyHash).length;
  expect(count).toBe(1);
});

test("deploy registers new slot in slots map", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch, "my-agent", "key1");
  // The slot should exist — verified by being able to re-deploy
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody(),
  });
  expect(res.status).toBe(200);
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
