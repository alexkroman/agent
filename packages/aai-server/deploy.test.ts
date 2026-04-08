// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { hashApiKey } from "./auth.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import {
  createTestOrchestrator,
  deployAgent,
  deployBody,
  TEST_AGENT_CONFIG,
} from "./test-utils.ts";

test("hashApiKey produces consistent hex output", async () => {
  const hash1 = await hashApiKey("test-key");
  const hash2 = await hashApiKey("test-key");
  expect(hash1).toBe(hash2);
  expect(hash1.length).toBe(64);
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
        env: { ASSEMBLYAI_API_KEY: "k" },
        worker: esmWorker,
        clientFiles: { "index.html": "<html></html>" },
        agentConfig: TEST_AGENT_CONFIG,
      }),
    });
    expect(res.status).toBe(200);
  });

  test("rejects invalid env (missing ASSEMBLYAI_API_KEY)", async () => {
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

  test("merges env with stored env", async () => {
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
      env: { ASSEMBLYAI_API_KEY: "stored-key" },
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
          'module.exports = { name: "pre-stored", systemPrompt: "Test", greeting: "", maxSteps: 1, tools: {} };',
        clientFiles: { "index.html": "<html></html>" },
        agentConfig: TEST_AGENT_CONFIG,
      }),
    });
    expect(res.status).toBe(200);
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
      hasState: false,
      hooks: {
        onConnect: false,
        onDisconnect: false,
        onError: false,
        onUserTranscript: false,
        maxStepsIsFn: false,
      },
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
