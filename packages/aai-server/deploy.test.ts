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
  VALID_ENV,
} from "./test-utils.ts";

test("hashApiKey produces argon2 PHC format and verifies", async () => {
  const hash = await hashApiKey("test-key");
  expect(hash).toMatch(/^\$argon2id\$/);
  expect(await verifyApiKeyHash("test-key", hash)).toBe(true);
  expect(await verifyApiKeyHash("wrong-key", hash)).toBe(false);
});

// ── Deploy body handling (POST /deploy, slug in the body) ────────────────

describe("POST /deploy body handling", () => {
  test("rejects invalid JSON body", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBeDefined();
  });

  test("rejects body missing required fields", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/deploy", {
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
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "my-agent",
        env: { MY_SECRET: "value", ...VALID_ENV },
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
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "my-agent", env: { ...VALID_ENV, EXISTING: "new-value" } }),
    });
    expect(res.status).toBe(200);
    const env = await store.getEnv("my-agent");
    expect(env?.EXISTING).toBe("new-value");
    expect(env?.EXTRA).toBe("stored-value");
  });

  test("replaces existing sandbox on redeploy", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch);
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "my-agent" }),
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
      env: { MY_SECRET: "stored-secret", ...VALID_ENV },
      worker: "w",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: [await hashApiKey("key1")],
      agentConfig: TEST_AGENT_CONFIG,
    });
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "pre-stored",
        worker:
          'export default { name: "pre-stored", systemPrompt: "Test", greeting: "", maxSteps: 1, tools: {} };',
        clientFiles: { "index.html": "<html></html>" },
        agentConfig: TEST_AGENT_CONFIG,
      }),
    });
    expect(res.status).toBe(200);
  });
});

// ── Env merge (deployAgentBundle) ─────────────────────────────────────────
// The server-side `defaultEnv` floor is gone — seeding a caller's own key is
// the CLI's job (`aai deploy` merges it client-side, and studio Publish runs
// that same CLI in-guest). What the server still owns is the precedence
// between what is already stored and what this deploy sends.

describe("deployAgentBundle env merge", () => {
  async function deployWith(params: {
    store: ReturnType<typeof createTestStore>;
    env?: Record<string, string>;
  }) {
    return await deployAgentBundle(
      { store: params.store, slots: createSlotCache() },
      {
        slug: "my-agent",
        apiKey: "key1",
        worker: "w",
        clientFiles: {},
        agentConfig: TEST_AGENT_CONFIG,
        ...(params.env && { env: params.env }),
      },
    );
  }

  test("an explicit deploy-time value wins over the stored one", async () => {
    const store = createTestStore();
    await store.putAgent({
      slug: "my-agent",
      env: { ASSEMBLYAI_API_KEY: "stored" },
      worker: "w",
      clientFiles: {},
      credential_hashes: [await hashApiKey("key1")],
      agentConfig: TEST_AGENT_CONFIG,
    });

    await deployWith({ store, env: { ASSEMBLYAI_API_KEY: "explicit" } });

    expect(await store.getEnv("my-agent")).toEqual({ ASSEMBLYAI_API_KEY: "explicit" });
  });

  test("a deploy keeps stored keys it does not mention", async () => {
    const store = createTestStore();
    await store.putAgent({
      slug: "my-agent",
      env: { OTHER: "kept", ASSEMBLYAI_API_KEY: "stored" },
      worker: "w",
      clientFiles: {},
      credential_hashes: [await hashApiKey("key1")],
      agentConfig: TEST_AGENT_CONFIG,
    });

    await deployWith({ store, env: { ASSEMBLYAI_API_KEY: "explicit" } });

    expect(await store.getEnv("my-agent")).toEqual({
      OTHER: "kept",
      ASSEMBLYAI_API_KEY: "explicit",
    });
  });
});

// ── Ownership resolution (deployAgentBundle hashes lazily) ────────────────

describe("deployAgentBundle ownership resolution", () => {
  const baseParams = {
    apiKey: "key1",
    worker: "w",
    clientFiles: {},
    env: VALID_ENV,
    agentConfig: TEST_AGENT_CONFIG,
  };

  test("unclaimed slug: derives and stores a hash that verifies the key", async () => {
    const store = createTestStore();
    const outcome = await deployAgentBundle(
      { store, slots: createSlotCache() },
      { ...baseParams, slug: "fresh-agent" },
    );
    expect(outcome.ok).toBe(true);
    const hashes = (await store.getAgent("fresh-agent"))?.credential_hashes ?? [];
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
    expect((await store.getAgent("owned-agent"))?.credential_hashes).toEqual([keyHash]);
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
    expect((await store.getAgent("their-agent"))?.credential_hashes).toEqual([ownerHash]);
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
    // Server-generated slugs carry the agent's own display name (from its
    // bundle-described config — deployBody's worker is named "test-agent")
    // plus the shared random suffix (slug-generate.ts).
    expect(body.slug).toMatch(/^test-agent-[a-z0-9]{6}$/);
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
    const record = await store.getAgent("test-agent");
    expect(record).not.toBeNull();
    expect(record?.slug).toBe("test-agent");
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

    const originalRecord = await store.getAgent("stolen-agent");
    const originalHashes = originalRecord?.credential_hashes ?? [];

    // Second deploy attempt by a different key (key2)
    const second = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key2", "Content-Type": "application/json" },
      body: deployBody({ slug: "stolen-agent" }),
    });
    expect(second.status).toBe(403);

    // Original owner's credential_hashes should not be modified
    const afterRecord = await store.getAgent("stolen-agent");
    expect(afterRecord?.credential_hashes).toEqual(originalHashes);
  });

  test("stores the config extracted from the worker bundle, ignoring any body config", async () => {
    const agentConfig: IsolateConfig = {
      name: "config-agent",
      systemPrompt: "Be helpful",
      toolSchemas: [],
    };
    const { fetch, store } = await createTestOrchestrator({
      inspect: async () => agentConfig,
    });

    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      // A client-supplied agentConfig must be ignored — the sandbox
      // extraction is the only source.
      body: deployBody({ slug: "config-test", agentConfig: { name: "attacker-config" } }),
    });
    expect(res.status).toBe(200);

    const stored = await store.getAgentConfig("config-test");
    expect(stored).toEqual(agentConfig);
  });

  test("rejects a worker whose bundle does not self-describe", async () => {
    const { fetch } = await createTestOrchestrator({ inspect: async () => undefined });
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "no-config" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does not self-describe");
  });

  test("rejects a worker bundle that fails to load in the sandbox", async () => {
    const { fetch } = await createTestOrchestrator({
      inspect: async () => {
        throw new Error("boom at import time");
      },
    });
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "bad-bundle" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("failed to load");
    expect(body.error).toContain("boom at import time");
  });

  test("rejects a worker whose extracted config is invalid", async () => {
    const { fetch } = await createTestOrchestrator({
      inspect: async () => ({ systemPrompt: 42 }),
    });
    const res = await fetch("/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody({ slug: "invalid-config" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid agent config");
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

    const record = await store.getAgent("owned-agent");
    expect(record?.credential_hashes).toHaveLength(1);
  });
});

// ── Credential preflight ───────────────────────────────────────────────────

describe("deploy credential preflight", () => {
  const PIPELINE_CONFIG: IsolateConfig = {
    name: "pipeline-agent",
    systemPrompt: "Test",
    toolSchemas: [],
    stt: { kind: "assemblyai", options: {} },
    llm: { kind: "anthropic", options: { model: "claude-sonnet-4-5" } },
    tts: { kind: "cartesia", options: {} },
  };

  function deployWith(params: {
    config?: IsolateConfig;
    env?: Record<string, string>;
    credentialPolicy?: "require" | "warn";
  }) {
    return deployAgentBundle(
      { store: createTestStore(), slots: createSlotCache() },
      {
        slug: "my-agent",
        apiKey: "key1",
        worker: "w",
        clientFiles: {},
        agentConfig: params.config ?? TEST_AGENT_CONFIG,
        ...(params.env && { env: params.env }),
        ...(params.credentialPolicy && { credentialPolicy: params.credentialPolicy }),
      },
    );
  }

  test("rejects an S2S agent deployed without its AssemblyAI key", async () => {
    const outcome = await deployWith({ env: {} });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
    if (!outcome.ok) expect(outcome.error).toContain("ASSEMBLYAI_API_KEY");
  });

  test("rejects a pipeline agent naming every missing provider key", async () => {
    const outcome = await deployWith({
      config: PIPELINE_CONFIG,
      env: { ASSEMBLYAI_API_KEY: "k" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("ANTHROPIC_API_KEY");
      expect(outcome.error).toContain("CARTESIA_API_KEY");
      expect(outcome.error).not.toContain("ASSEMBLYAI_API_KEY");
    }
  });

  test("accepts a pipeline agent once every provider key is present", async () => {
    const outcome = await deployWith({
      config: PIPELINE_CONFIG,
      env: { ASSEMBLYAI_API_KEY: "a", ANTHROPIC_API_KEY: "b", CARTESIA_API_KEY: "c" },
    });
    expect(outcome).toMatchObject({ ok: true, slug: "my-agent" });
    if (outcome.ok) expect(outcome.warnings).toBeUndefined();
  });

  test("an empty-string credential counts as missing", async () => {
    const outcome = await deployWith({ env: { ASSEMBLYAI_API_KEY: "" } });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
  });

  test("enforces the agent's declared requiredEnv keys", async () => {
    const outcome = await deployWith({
      config: { ...TEST_AGENT_CONFIG, requiredEnv: ["STRIPE_KEY"] },
      env: VALID_ENV,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("STRIPE_KEY");
  });

  test("credentialPolicy 'warn' deploys anyway and reports the missing keys", async () => {
    const outcome = await deployWith({ env: {}, credentialPolicy: "warn" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.warnings).toHaveLength(1);
      expect(outcome.warnings?.[0]).toContain("ASSEMBLYAI_API_KEY");
    }
  });

  test("a rejected deploy stores nothing", async () => {
    const store = createTestStore();
    const outcome = await deployAgentBundle(
      { store, slots: createSlotCache() },
      {
        slug: "unstored",
        apiKey: "key1",
        worker: "w",
        clientFiles: {},
        agentConfig: TEST_AGENT_CONFIG,
      },
    );
    expect(outcome.ok).toBe(false);
    expect(await store.getAgent("unstored")).toBeNull();
  });
});

// ── Cross-service invalidation (split deployment) ─────────────────────────

describe("deployAgentBundle version bump", () => {
  test("a deploy bumps the deploy version so other services rebuild sandboxes", async () => {
    const store = createTestStore();
    await deployAgentBundle(
      { store, slots: createSlotCache() },
      {
        slug: "published-agent",
        apiKey: "key1",
        worker: "w",
        clientFiles: {},
        env: VALID_ENV,
        agentConfig: TEST_AGENT_CONFIG,
      },
    );
    await expect(store.getAgentVersion("published-agent")).resolves.toBe(1);

    const outcome = await deployAgentBundle(
      { store, slots: createSlotCache() },
      {
        slug: "published-agent",
        apiKey: "key1",
        worker: "w2",
        clientFiles: {},
        env: VALID_ENV,
        agentConfig: TEST_AGENT_CONFIG,
      },
    );
    expect(outcome.ok).toBe(true);
    await expect(store.getAgentVersion("published-agent")).resolves.toBe(2);
  });

  test("a refused deploy does not bump", async () => {
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
      {
        slug: "their-agent",
        apiKey: "intruder-key",
        worker: "w",
        clientFiles: {},
        agentConfig: TEST_AGENT_CONFIG,
      },
    );
    expect(outcome.ok).toBe(false);
    await expect(store.getAgentVersion("their-agent")).resolves.toBe(1);
  });
});
