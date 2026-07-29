// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { deployAgentBundle } from "./deploy.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { hashApiKey, verifyApiKeyHash } from "./secrets.ts";
import {
  createTestOrchestrator,
  createTestStore,
  deployAgent,
  deployBody,
  TEST_AGENT_CONFIG,
} from "./test-utils.ts";

test("hashApiKey produces argon2 PHC format and verifies", async () => {
  const hash = await hashApiKey("test-key");
  expect(hash).toMatch(/^\$argon2id\$/);
  expect(await verifyApiKeyHash("test-key", hash)).toBe(true);
  expect(await verifyApiKeyHash("wrong-key", hash)).toBe(false);
});

// ── Slug-scoped deploy (legacy: POST /:slug/deploy) ──────────────────────

describe("POST /:slug/deploy", () => {
  test("rejects invalid JSON body", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBeDefined();
  });

  test("rejects body missing required fields", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: JSON.stringify({ worker: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("accepts ESM bundle (validation deferred to isolate)", async () => {
    const { fetch } = await createTestOrchestrator();
    // Real Vite SSR output: minified zod import + named re-export
    const esmWorker = `import{z as e}from"/app/_zod.mjs";var s={name:"test-agent",systemPrompt:"Test"};export{s as default};`;
    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: JSON.stringify({
        env: { MY_SECRET: "value" },
        worker: esmWorker,
        clientFiles: { "index.html": "<html></html>" },
        agentConfig: TEST_AGENT_CONFIG,
      }),
    });
    expect(res.status).toBe(200);
  });

  test("merges env with stored env", async () => {
    const { fetch, store } = await createTestOrchestrator();
    await deployAgent(fetch);
    await store.putEnv("my-agent", {
      EXISTING: "original-value",
      EXTRA: "stored-value",
    });
    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ env: { EXISTING: "new-value" } }),
    });
    expect(res.status).toBe(200);
    const env = await store.getEnv("my-agent");
    expect(env?.EXISTING).toBe("new-value");
    expect(env?.EXTRA).toBe("stored-value");
  });

  test("replaces existing sandbox on redeploy", async () => {
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
    expect(body.slug).toBe("my-agent");
  });

  test("works without env in body (uses stored env)", async () => {
    const { fetch, store } = await createTestOrchestrator();
    await store.putAgent({
      slug: "pre-stored",
      env: { MY_SECRET: "stored-secret" },
      worker: "w",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: [await hashApiKey("key1")],
      agentConfig: TEST_AGENT_CONFIG,
    });
    const res = await fetch("/pre-stored/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: JSON.stringify({
        worker:
          'export default { name: "pre-stored", systemPrompt: "Test", greeting: "", maxSteps: 1, tools: {} };',
        clientFiles: { "index.html": "<html></html>" },
        agentConfig: TEST_AGENT_CONFIG,
      }),
    });
    expect(res.status).toBe(200);
  });
});

// ── defaultEnv (deployAgentBundle) ────────────────────────────────────────

describe("deployAgentBundle defaultEnv", () => {
  async function deployWith(params: {
    store: ReturnType<typeof createTestStore>;
    defaultEnv?: Record<string, string>;
    env?: Record<string, string>;
  }) {
    return await deployAgentBundle(
      { store: params.store, slots: createSlotCache() },
      {
        slug: "my-agent",
        apiKey: "key1",
        keyHash: await hashApiKey("key1"),
        worker: "w",
        clientFiles: {},
        agentConfig: TEST_AGENT_CONFIG,
        ...(params.env && { env: params.env }),
        ...(params.defaultEnv && { defaultEnv: params.defaultEnv }),
      },
    );
  }

  test("fills in a key absent from both stored and explicit env", async () => {
    const store = createTestStore();
    const outcome = await deployWith({ store, defaultEnv: { ASSEMBLYAI_API_KEY: "fallback" } });
    expect(outcome.ok).toBe(true);
    expect(await store.getEnv("my-agent")).toEqual({ ASSEMBLYAI_API_KEY: "fallback" });
  });

  test("a stored value wins over defaultEnv", async () => {
    const store = createTestStore();
    await store.putAgent({
      slug: "my-agent",
      env: { ASSEMBLYAI_API_KEY: "user-set" },
      worker: "w",
      clientFiles: {},
      credential_hashes: [await hashApiKey("key1")],
      agentConfig: TEST_AGENT_CONFIG,
    });
    await deployWith({ store, defaultEnv: { ASSEMBLYAI_API_KEY: "fallback" } });
    expect(await store.getEnv("my-agent")).toEqual({ ASSEMBLYAI_API_KEY: "user-set" });
  });

  test("an explicit deploy-time value wins over defaultEnv", async () => {
    const store = createTestStore();
    await deployWith({
      store,
      defaultEnv: { ASSEMBLYAI_API_KEY: "fallback" },
      env: { ASSEMBLYAI_API_KEY: "explicit" },
    });
    expect(await store.getEnv("my-agent")).toEqual({ ASSEMBLYAI_API_KEY: "explicit" });
  });

  test("defaultEnv does not disturb unrelated stored keys", async () => {
    const store = createTestStore();
    await store.putAgent({
      slug: "my-agent",
      env: { OTHER: "kept" },
      worker: "w",
      clientFiles: {},
      credential_hashes: [await hashApiKey("key1")],
      agentConfig: TEST_AGENT_CONFIG,
    });
    await deployWith({ store, defaultEnv: { ASSEMBLYAI_API_KEY: "fallback" } });
    expect(await store.getEnv("my-agent")).toEqual({
      OTHER: "kept",
      ASSEMBLYAI_API_KEY: "fallback",
    });
  });
});

// ── Lazy keyHash (deployAgentBundle without a precomputed hash) ───────────

describe("deployAgentBundle without a precomputed keyHash", () => {
  const baseParams = {
    apiKey: "key1",
    worker: "w",
    clientFiles: {},
    agentConfig: TEST_AGENT_CONFIG,
  };

  test("unclaimed slug: derives and stores a hash that verifies the key", async () => {
    const store = createTestStore();
    const outcome = await deployAgentBundle(
      { store, slots: createSlotCache() },
      { ...baseParams, slug: "fresh-agent" },
    );
    expect(outcome.ok).toBe(true);
    const hashes = (await store.getManifest("fresh-agent"))?.credential_hashes ?? [];
    expect(hashes).toHaveLength(1);
    expect(await verifyApiKeyHash("key1", hashes[0] ?? "")).toBe(true);
  });

  test("owned slug: reuses the matched stored hash — nothing appended", async () => {
    const store = createTestStore();
    const keyHash = await hashApiKey("key1");
    await store.putAgent({
      slug: "owned-agent",
      env: {},
      worker: "w",
      clientFiles: {},
      credential_hashes: [keyHash],
      agentConfig: TEST_AGENT_CONFIG,
    });
    const outcome = await deployAgentBundle(
      { store, slots: createSlotCache() },
      { ...baseParams, slug: "owned-agent" },
    );
    expect(outcome.ok).toBe(true);
    expect((await store.getManifest("owned-agent"))?.credential_hashes).toEqual([keyHash]);
  });

  test("slug owned by another key: 403, hashes untouched", async () => {
    const store = createTestStore();
    const ownerHash = await hashApiKey("owner-key");
    await store.putAgent({
      slug: "their-agent",
      env: {},
      worker: "w",
      clientFiles: {},
      credential_hashes: [ownerHash],
      agentConfig: TEST_AGENT_CONFIG,
    });
    const outcome = await deployAgentBundle(
      { store, slots: createSlotCache() },
      { ...baseParams, slug: "their-agent", apiKey: "intruder-key" },
    );
    expect(outcome).toEqual({
      ok: false,
      status: 403,
      error: "Forbidden: slug already owned by another user",
    });
    expect((await store.getManifest("their-agent"))?.credential_hashes).toEqual([ownerHash]);
  });
});

// ── Top-level deploy (POST /deploy) — server generates slug ───────────────

describe("POST /deploy", () => {
  test("generates slug when not provided in body", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; slug: string };
    expect(body.ok).toBe(true);
    expect(body.slug).toBeTruthy();
    // Server-generated slugs are lowercase hyphenated words
    expect(body.slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  test("uses slug from body when provided", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "my-custom-slug" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; slug: string };
    expect(body.slug).toBe("my-custom-slug");
  });

  test("rejects invalid slug format", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "INVALID SLUG!" }),
    });
    expect(res.status).toBe(400);
  });

  test("requires authentication", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: deployBody(),
    });
    expect(res.status).toBe(401);
  });

  test("stores agent and returns slug", async () => {
    const { fetch, store } = await createTestOrchestrator();
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "test-agent" }),
    });
    expect(res.status).toBe(200);
    const manifest = await store.getManifest("test-agent");
    expect(manifest).not.toBeNull();
    expect(manifest?.slug).toBe("test-agent");
  });

  test("returns 403 when different user tries to deploy to an owned slug", async () => {
    const { fetch, store } = await createTestOrchestrator();

    // First deploy by key1
    const first = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "stolen-agent" }),
    });
    expect(first.status).toBe(200);

    const originalManifest = await store.getManifest("stolen-agent");
    const originalHashes = originalManifest?.credential_hashes ?? [];

    // Second deploy attempt by a different key (key2)
    const second = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key2", "Content-Type": "application/json" },
      body: deployBody({ slug: "stolen-agent" }),
    });
    expect(second.status).toBe(403);

    // Original owner's credential_hashes should not be modified
    const afterManifest = await store.getManifest("stolen-agent");
    expect(afterManifest?.credential_hashes).toEqual(originalHashes);
  });

  test("stores agentConfig from deploy body", async () => {
    const { fetch, store } = await createTestOrchestrator();
    const agentConfig: IsolateConfig = {
      name: "config-agent",
      systemPrompt: "Be helpful",
      toolSchemas: [],
      allowedHosts: [],
    };

    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "config-test", agentConfig }),
    });
    expect(res.status).toBe(200);

    const stored = await store.getAgentConfig("config-test");
    expect(stored).toEqual(agentConfig);
  });

  test("redeploy to same slug preserves ownership", async () => {
    const { fetch, store } = await createTestOrchestrator();

    // First deploy
    await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "owned-agent" }),
    });

    // Second deploy by same key
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "owned-agent" }),
    });
    expect(res.status).toBe(200);

    const manifest = await store.getManifest("owned-agent");
    expect(manifest?.credential_hashes).toHaveLength(1);
  });
});
