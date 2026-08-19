// Copyright 2025 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { deployAgentBundle } from "./deploy.ts";
import { hashApiKey, verifyApiKeyHash } from "./secrets.ts";
import {
  authHeaders,
  createTestOrchestrator,
  createTestStore,
  deploy,
  deployAgent,
  deployBody,
  VALID_ENV,
} from "./test-utils.ts";

test("hashApiKey produces a sha256 digest and verifies", () => {
  const hash = hashApiKey("test-key");
  expect(hash).toMatch(/^sha256:/);
  expect(verifyApiKeyHash("test-key", hash)).toBe(true);
  expect(verifyApiKeyHash("wrong-key", hash)).toBe(false);
});

// ── Deploy body handling (POST /deploy, slug in the body) ────────────────

describe("POST /deploy body handling", () => {
  test("rejects invalid JSON body", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders(),
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBeDefined();
  });

  test("rejects body missing required fields", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders(),
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
      headers: authHeaders(),
      body: JSON.stringify({
        slug: "my-agent",
        env: { MY_SECRET: "value", ...VALID_ENV },
        worker: esmWorker,
        clientFiles: { "index.html": "<html></html>" },
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
    const res = await deploy(fetch, {
      body: { slug: "my-agent", env: { ...VALID_ENV, EXISTING: "new-value" } },
    });
    expect(res.status).toBe(200);
    const env = await store.getEnv("my-agent");
    expect(env?.EXISTING).toBe("new-value");
    expect(env?.EXTRA).toBe("stored-value");
  });

  test("replaces existing sandbox on redeploy", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch);
    const res = await deploy(fetch, { body: { slug: "my-agent" } });
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
    });
    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        slug: "pre-stored",
        worker:
          'export default { name: "pre-stored", systemPrompt: "Test", greeting: "", maxSteps: 1, tools: {} };',
        clientFiles: { "index.html": "<html></html>" },
      }),
    });
    expect(res.status).toBe(200);
    // The parenthetical in the name is the whole claim, and the status code
    // does not carry it: a regression that dropped the stored env on an
    // env-less deploy answered 200 just the same.
    expect(await store.getEnv("pre-stored")).toEqual({
      MY_SECRET: "stored-secret",
      ...VALID_ENV,
    });
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
      { store: params.store },
      {
        slug: "my-agent",
        apiKey: "key1",
        worker: "w",
        clientFiles: {},
        ...omitUndefined({ env: params.env }),
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
  };

  test("unclaimed slug: derives and stores a hash that verifies the key", async () => {
    const store = createTestStore();
    const outcome = await deployAgentBundle({ store }, { ...baseParams, slug: "fresh-agent" });
    expect(outcome.ok).toBe(true);
    const hashes = (await store.getAgent("fresh-agent"))?.credential_hashes ?? [];
    expect(hashes).toHaveLength(1);
    expect(await verifyApiKeyHash("key1", hashes[0] ?? "")).toBe(true);
  });

  test("records the harness image tag the deploy ran against", async () => {
    const store = createTestStore();
    const outcome = await deployAgentBundle(
      { store, harnessImageTag: async () => "aai-guest-harness:feedbeef" },
      { ...baseParams, slug: "pinned-agent" },
    );
    expect(outcome.ok).toBe(true);
    expect((await store.getAgent("pinned-agent"))?.harness_image_tag).toBe(
      "aai-guest-harness:feedbeef",
    );
  });

  test("a failed tag computation records no pin and does not fail the deploy", async () => {
    const store = createTestStore();
    const outcome = await deployAgentBundle(
      { store, harnessImageTag: () => Promise.reject(new Error("modal down")) },
      { ...baseParams, slug: "unpinned-agent" },
    );
    expect(outcome.ok).toBe(true);
    expect((await store.getAgent("unpinned-agent"))?.harness_image_tag).toBeNull();
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
    });
    const outcome = await deployAgentBundle({ store }, { ...baseParams, slug: "owned-agent" });
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
    });
    const outcome = await deployAgentBundle(
      { store },
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

// ── Preview-slug guard (deployAgentBundle) ────────────────────────────────
// The `-preview` suffix is owned by the studio's auto-preview deploys and
// reaped by the orphan-preview pg_cron sweep, so a CLI caller must not be able
// to claim it by accident and lose the agent (plus its app-database data) to
// the reaper. Only an explicit opt-in — set by the studio's own in-guest
// deploy — clears the suffix.

describe("deployAgentBundle preview-slug guard", () => {
  const baseParams = {
    apiKey: "key1",
    worker: "w",
    clientFiles: {},
    env: VALID_ENV,
  };

  test("a requested -preview slug is rejected with a 400", async () => {
    const store = createTestStore();
    const outcome = await deployAgentBundle({ store }, { ...baseParams, slug: "my-app-preview" });
    expect(outcome).toEqual({
      ok: false,
      status: 400,
      error: 'The "-preview" suffix is reserved for studio previews',
    });
    // No row was written — the guard runs before any side effect.
    expect(await store.getAgent("my-app-preview")).toBeNull();
  });

  test("allowPreviewSlug opts in, so the studio's preview deploy succeeds", async () => {
    const store = createTestStore();
    const outcome = await deployAgentBundle(
      { store },
      { ...baseParams, slug: "my-app-preview", allowPreviewSlug: true },
    );
    expect(outcome.ok).toBe(true);
    expect(await store.getAgent("my-app-preview")).not.toBeNull();
  });

  test("a normal slug is unaffected", async () => {
    const store = createTestStore();
    const outcome = await deployAgentBundle({ store }, { ...baseParams, slug: "my-app" });
    expect(outcome.ok).toBe(true);
  });

  test("only the suffix matters — `preview` elsewhere is fine", async () => {
    const store = createTestStore();
    const outcome = await deployAgentBundle({ store }, { ...baseParams, slug: "preview-tool" });
    expect(outcome.ok).toBe(true);
  });
});

// ── Top-level deploy (POST /deploy) — server generates slug ───────────────

describe("POST /deploy", () => {
  // Was two tests — "generates slug when not provided in body" and "a generated
  // slug is human-id words plus a suffix" — with byte-identical bodies under
  // two names.
  test("a slugless deploy is named human-id words plus a suffix", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await deploy(fetch);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string };
    // Words from human-id plus the shared random suffix (slug-generate.ts).
    // The platform derives nothing from the bundle, so nothing about the agent
    // reaches its name.
    expect(body.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*-[a-z0-9]{6}$/);
  });

  test("uses slug from body when provided", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await deploy(fetch, { body: { slug: "my-custom-slug" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; slug: string };
    expect(body.slug).toBe("my-custom-slug");
  });

  test("rejects invalid slug format", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await deploy(fetch, { body: { slug: "INVALID SLUG!" } });
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
    const res = await deploy(fetch, { body: { slug: "test-agent" } });
    expect(res.status).toBe(200);
    const record = await store.getAgent("test-agent");
    expect(record).not.toBeNull();
    expect(record?.slug).toBe("test-agent");
  });

  test("returns 403 when different user tries to deploy to an owned slug", async () => {
    const { fetch, store } = await createTestOrchestrator();

    // First deploy by key1
    const first = await deploy(fetch, { body: { slug: "stolen-agent" } });
    expect(first.status).toBe(200);

    const originalRecord = await store.getAgent("stolen-agent");
    const originalHashes = originalRecord?.credential_hashes ?? [];

    // Second deploy attempt by a different key (key2)
    const second = await deploy(fetch, { key: "key2", body: { slug: "stolen-agent" } });
    expect(second.status).toBe(403);

    // Original owner's credential_hashes should not be modified
    const afterRecord = await store.getAgent("stolen-agent");
    expect(afterRecord?.credential_hashes).toEqual(originalHashes);
  });

  test("a body-supplied agentConfig is ignored, not stored", async () => {
    // The platform records no description of the bundle at all, so there is
    // nothing for a client-sent config to poison.
    const { fetch, store } = await createTestOrchestrator();
    const res = await deploy(fetch, {
      body: { slug: "config-test", agentConfig: { name: "attacker-config" } },
    });
    expect(res.status).toBe(200);
    const stored = await store.getAgent("config-test");
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty("config");
  });

  test("redeploy to same slug preserves ownership", async () => {
    const { fetch, store } = await createTestOrchestrator();

    // First deploy
    await deploy(fetch, { body: { slug: "owned-agent" } });

    // Second deploy by same key
    const res = await deploy(fetch, { body: { slug: "owned-agent" } });
    expect(res.status).toBe(200);

    const record = await store.getAgent("owned-agent");
    expect(record?.credential_hashes).toHaveLength(1);
  });
});

// ── Storage on rejection ───────────────────────────────────────────────────

describe("deploy rejection", () => {
  test("a rejected deploy stores nothing", async () => {
    // Rejection happens before any side effect, so a live agent's artifacts
    // are untouched by a deploy that never lands.
    const store = createTestStore();
    const outcome = await deployAgentBundle(
      { store },
      {
        slug: "studio", // reserved — would shadow the studio routes
        apiKey: "key1",
        worker: "w",
        clientFiles: {},
      },
    );
    expect(outcome).toMatchObject({ ok: false, status: 400 });
    expect(await store.getAgent("studio")).toBeNull();
  });
});

// ── Cross-service invalidation (split deployment) ─────────────────────────

describe("deployAgentBundle version bump", () => {
  test("a deploy bumps the deploy version so other services rebuild sandboxes", async () => {
    const store = createTestStore();
    await deployAgentBundle(
      { store },
      {
        slug: "published-agent",
        apiKey: "key1",
        worker: "w",
        clientFiles: {},
        env: VALID_ENV,
      },
    );
    await expect(store.getAgentVersion("published-agent")).resolves.toBe(1);

    const outcome = await deployAgentBundle(
      { store },
      {
        slug: "published-agent",
        apiKey: "key1",
        worker: "w2",
        clientFiles: {},
        env: VALID_ENV,
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
    });
    const outcome = await deployAgentBundle(
      { store },
      {
        slug: "their-agent",
        apiKey: "intruder-key",
        worker: "w",
        clientFiles: {},
      },
    );
    expect(outcome.ok).toBe(false);
    await expect(store.getAgentVersion("their-agent")).resolves.toBe(1);
  });
});
