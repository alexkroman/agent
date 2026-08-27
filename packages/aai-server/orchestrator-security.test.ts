// Copyright 2025 the AAI authors. MIT license.
/**
 * Orchestrator security tests: cross-agent tenant isolation (storage, auth,
 * deploy) and platform credential handling. Slug validation, security
 * headers, and WebSocket URL validation tests live in
 * orchestrator-security-validation.test.ts.
 */
import { describe, expect, test } from "vitest";
import { loadBundleParts } from "./sandbox-resolve.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { hashApiKey } from "./secrets.ts";
import {
  authFetch,
  createTestOrchestrator,
  createTestStore,
  deploy,
  deployAgent,
} from "./test-utils.ts";

// ── Cross-Agent Auth Isolation ─────────────────────────────────────────
//
// A "cross-agent storage isolation" suite used to open this file, asserting that a
// foreign key answers 404 on `GET /:slug/storage`. The route went with tenant
// databases, and it is deliberately NOT retargeted at `/:slug/secret`: the spec
// below already asserts that exact property on that exact route, three methods
// deep. See the note further down about the two status-only copies that were
// deleted for the same reason.

describe("cross-agent auth isolation", () => {
  test("agent A's key cannot deploy to agent B's slug", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Alpha's key tries to redeploy over beta
    const res = await deploy(fetch, { key: "key-alpha", body: { slug: "agent-beta" } });
    expect(res.status).toBe(403);
  });

  test("agent A's key cannot delete agent B", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    const res = await authFetch(fetch, "/agent-beta", { method: "DELETE", key: "key-alpha" });
    // 404, not 403 — a non-owner cannot distinguish a claimed slug from a free one.
    expect(res.status).toBe(404);
  });

  test("agent A's key cannot manage agent B's secrets", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Every non-owner attempt answers 404 (not 403): the routes reveal nothing
    // about whether agent-beta exists — see requireOwner in middleware.ts.
    // Try to list agent B's secrets with agent A's key
    const listRes = await authFetch(fetch, "/agent-beta/secret", {
      method: "GET",
      key: "key-alpha",
    });
    expect(listRes.status).toBe(404);

    // Try to set a secret on agent B with agent A's key
    const setRes = await authFetch(fetch, "/agent-beta/secret", {
      method: "PUT",
      key: "key-alpha",
      body: { MY_SECRET: "injected" },
    });
    expect(setRes.status).toBe(404);

    // Try to delete a secret from agent B with agent A's key
    const delRes = await authFetch(fetch, "/agent-beta/secret/MY_SECRET", {
      method: "DELETE",
      key: "key-alpha",
    });
    expect(delRes.status).toBe(404);
  });

  test("403 message does not reveal slug existence to unauthorized users", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");

    // Use wrong key — error message should not echo the slug back
    const res = await deploy(fetch, { key: "wrong-key", body: { slug: "agent-alpha" } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    // The deploy route says the requested slug is taken (that is inherent to
    // claiming a named slug) but never echoes the slug itself.
    expect(body.error).toBe("Forbidden: slug already owned by another user");
    expect(body.error).not.toContain("agent-alpha");
  });
});

// ── Platform Credential Handling ────────────────────────────────────────

describe("platform credential handling", () => {
  // This used to round-trip the memory store and assert on `store.getEnv`,
  // which is `bundle-store.test.ts`'s subject and says nothing about the
  // resolution path its name promises. `loadBundleParts` is the step that
  // actually assembles what a spawn hands the guest, so a regression that
  // stopped reading the env there fails here.
  test("the sandbox resolution path carries the whole stored env to the guest", async () => {
    const store = createTestStore();
    const env = {
      ASSEMBLYAI_API_KEY: "platform-secret-key",
      USER_SECRET: "user-value",
      ANOTHER_SECRET: "another-value",
    };

    await store.putAgent({
      slug: "cred-agent",
      env,
      credential_hashes: [await hashApiKey("key1")],
      worker: "console.log('w');",
      clientFiles: {},
    });

    const parts = await loadBundleParts("cred-agent", { slots: createSlotCache(), store });
    expect(parts).not.toBeNull();
    // `toEqual`, not three `toHaveProperty`s: the guest gets exactly the stored
    // env and nothing the platform invented (a `DATABASE_URL` is injected one
    // step later, and only when the app has a provisioned database).
    expect(parts?.env).toEqual(env);
  });

  // "ASSEMBLYAI_API_KEY can be overwritten / deleted via secrets API" used to
  // sit here as two status-only copies of `secret-handler.test.ts`'s "secret
  // set allows overwriting ASSEMBLYAI_API_KEY" and "secret delete allows
  // removing ASSEMBLYAI_API_KEY" — same routes, same setup, one assertion
  // fewer each. The secrets API's own suite owns that surface; this file owns
  // tenant isolation and what a spawn is handed.
});

// ── Multi-Tenant Deploy Isolation ──────────────────────────────────────

describe("multi-tenant deploy isolation", () => {
  test("deploying agent A does not affect agent B", async () => {
    const { fetch, store } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Both agents have separate records
    const alphaManifest = await store.getAgent("agent-alpha");
    const betaManifest = await store.getAgent("agent-beta");

    expect(alphaManifest).not.toBeNull();
    expect(betaManifest).not.toBeNull();
    expect(alphaManifest?.slug).toBe("agent-alpha");
    expect(betaManifest?.slug).toBe("agent-beta");
  });

  test("redeploying agent A does not affect agent B's data", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Store a secret in beta's env
    await authFetch(fetch, "/agent-beta/secret", {
      method: "PUT",
      key: "key-beta",
      body: { PERSIST_TEST: "should-survive" },
    });

    // Redeploy agent alpha
    await deploy(fetch, { key: "key-alpha", body: { slug: "agent-alpha" } });

    // Beta's secret should still be intact
    const betaRead = await authFetch(fetch, "/agent-beta/secret", {
      method: "GET",
      key: "key-beta",
    });
    expect(betaRead.status).toBe(200);
    expect(((await betaRead.json()) as { vars: string[] }).vars).toContain("PERSIST_TEST");
  });

  test("deleting agent A does not delete agent B", async () => {
    const { fetch, store } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Delete alpha. `toBeLessThan(500)` used to stand here, which passes on the
    // 404 and 403 in which nothing is deleted at all — and then "beta still
    // exists" is true for the wrong reason. The delete must SUCCEED, and alpha
    // must really be gone, before the surviving-neighbour claim means anything.
    const deleteRes = await authFetch(fetch, "/agent-alpha", {
      method: "DELETE",
      key: "key-alpha",
    });
    expect(deleteRes.status).toBe(200);
    expect(await store.getAgent("agent-alpha")).toBeNull();

    // Beta still exists
    const betaManifest = await store.getAgent("agent-beta");
    expect(betaManifest).not.toBeNull();
    expect(betaManifest?.slug).toBe("agent-beta");
  });
});
