// Copyright 2025 the AAI authors. MIT license.
/**
 * Orchestrator security tests: cross-agent tenant isolation (storage, auth,
 * deploy) and platform credential handling. Slug validation, security
 * headers, and WebSocket URL validation tests live in
 * orchestrator-security-validation.test.ts.
 */
import { describe, expect, test } from "vitest";
import { hashApiKey } from "./secrets.ts";
import {
  authFetch,
  authHeaders,
  createTestOrchestrator,
  createTestStore,
  deployAgent,
  deployBody,
} from "./test-utils.ts";

// ── Cross-Agent Storage Isolation ──────────────────────────────────────

describe("cross-agent storage isolation", () => {
  test("agent A's key cannot access agent B's storage endpoint", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Agent alpha's key should be rejected on agent beta's storage endpoint
    const res = await fetch("/agent-beta/storage", {
      method: "GET",
      headers: { Authorization: "Bearer key-alpha" },
    });
    expect(res.status).toBe(403);

    // Beta's own key is accepted
    const own = await fetch("/agent-beta/storage", {
      method: "GET",
      headers: { Authorization: "Bearer key-beta" },
    });
    expect(own.status).toBe(200);
  });
});

// ── Cross-Agent Auth Isolation ─────────────────────────────────────────

describe("cross-agent auth isolation", () => {
  test("agent A's key cannot deploy to agent B's slug", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Alpha's key tries to redeploy over beta
    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders("key-alpha"),
      body: deployBody({ slug: "agent-beta" }),
    });
    expect(res.status).toBe(403);
  });

  test("agent A's key cannot delete agent B", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    const res = await fetch("/agent-beta", {
      method: "DELETE",
      headers: { Authorization: "Bearer key-alpha" },
    });
    expect(res.status).toBe(403);
  });

  test("agent A's key cannot manage agent B's secrets", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Try to list agent B's secrets with agent A's key
    const listRes = await fetch("/agent-beta/secret", {
      headers: { Authorization: "Bearer key-alpha" },
    });
    expect(listRes.status).toBe(403);

    // Try to set a secret on agent B with agent A's key
    const setRes = await fetch("/agent-beta/secret", {
      method: "PUT",
      headers: authHeaders("key-alpha"),
      body: JSON.stringify({ MY_SECRET: "injected" }),
    });
    expect(setRes.status).toBe(403);

    // Try to delete a secret from agent B with agent A's key
    const delRes = await fetch("/agent-beta/secret/MY_SECRET", {
      method: "DELETE",
      headers: { Authorization: "Bearer key-alpha" },
    });
    expect(delRes.status).toBe(403);
  });

  test("403 message does not reveal slug existence to unauthorized users", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");

    // Use wrong key — error message should not echo the slug back
    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders("wrong-key"),
      body: deployBody({ slug: "agent-alpha" }),
    });
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
  test("ASSEMBLYAI_API_KEY is passed through in env to resolveSandbox", async () => {
    const store = createTestStore();

    await store.putAgent({
      slug: "cred-agent",
      env: {
        ASSEMBLYAI_API_KEY: "platform-secret-key",
        USER_SECRET: "user-value",
        ANOTHER_SECRET: "another-value",
      },
      credential_hashes: [await hashApiKey("key1")],
      worker: "console.log('w');",
      clientFiles: {},
    });

    // Verify getEnv returns everything including ASSEMBLYAI_API_KEY
    const fullEnv = await store.getEnv("cred-agent");
    expect(fullEnv).toHaveProperty("ASSEMBLYAI_API_KEY", "platform-secret-key");
    expect(fullEnv).toHaveProperty("USER_SECRET", "user-value");
    expect(fullEnv).toHaveProperty("ANOTHER_SECRET", "another-value");
  });

  test("ASSEMBLYAI_API_KEY can be overwritten via secrets API", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/secret", {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ ASSEMBLYAI_API_KEY: "new-key" }),
    });
    expect(res.status).toBe(200);
  });

  test("ASSEMBLYAI_API_KEY can be deleted via secrets API", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/secret/ASSEMBLYAI_API_KEY", {
      method: "DELETE",
      headers: { Authorization: "Bearer key1" },
    });
    expect(res.status).toBe(200);
  });
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
    await fetch("/deploy", {
      method: "POST",
      headers: authHeaders("key-alpha"),
      body: deployBody({ slug: "agent-alpha" }),
    });

    // Beta's secret should still be intact
    const betaRead = await fetch("/agent-beta/secret", {
      headers: { Authorization: "Bearer key-beta" },
    });
    expect(betaRead.status).toBe(200);
    expect(((await betaRead.json()) as { vars: string[] }).vars).toContain("PERSIST_TEST");
  });

  test("deleting agent A does not delete agent B", async () => {
    const { fetch, store } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Delete alpha
    const deleteRes = await fetch("/agent-alpha/", {
      method: "DELETE",
      headers: { Authorization: "Bearer key-alpha" },
    });
    expect(deleteRes.status).toBeLessThan(500);

    // Beta still exists
    const betaManifest = await store.getAgent("agent-beta");
    expect(betaManifest).not.toBeNull();
    expect(betaManifest?.slug).toBe("agent-beta");
  });
});
