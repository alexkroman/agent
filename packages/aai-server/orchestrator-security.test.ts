// Copyright 2025 the AAI authors. MIT license.
/**
 * Orchestrator security tests: cross-agent tenant isolation (KV, auth,
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
  TEST_AGENT_CONFIG,
} from "./test-utils.ts";

// ── Cross-Agent KV Isolation ───────────────────────────────────────────

describe("cross-agent KV isolation", () => {
  test("agent A cannot read agent B's KV data via API", async () => {
    const { fetch } = await createTestOrchestrator();

    // Deploy two agents with different keys
    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Agent alpha writes a KV entry
    await authFetch(fetch, "/agent-alpha/kv", {
      key: "key-alpha",
      body: { op: "set", key: "secret", value: "alpha-secret-data" },
    });

    // Agent alpha can read its own data
    const alphaRead = await fetch("/agent-alpha/kv?key=secret", {
      headers: { Authorization: "Bearer key-alpha" },
    });
    expect(alphaRead.status).toBe(200);
    const alphaData = await alphaRead.json();
    expect(alphaData).toBe("alpha-secret-data");

    // Agent beta writes a KV entry with the same key name
    await authFetch(fetch, "/agent-beta/kv", {
      key: "key-beta",
      body: { op: "set", key: "secret", value: "beta-secret-data" },
    });

    // Agent beta reads its own data — should get beta's value, not alpha's
    const betaRead = await fetch("/agent-beta/kv?key=secret", {
      headers: { Authorization: "Bearer key-beta" },
    });
    expect(betaRead.status).toBe(200);
    const betaData = await betaRead.json();
    expect(betaData).toBe("beta-secret-data");

    // Verify alpha's data is still its own
    const alphaVerify = await fetch("/agent-alpha/kv?key=secret", {
      headers: { Authorization: "Bearer key-alpha" },
    });
    expect(await alphaVerify.json()).toBe("alpha-secret-data");
  });

  test("agent A's key cannot access agent B's KV endpoint", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Agent alpha's key should be rejected on agent beta's KV endpoint
    const res = await authFetch(fetch, "/agent-beta/kv", {
      key: "key-alpha",
      body: { op: "get", key: "test" },
    });
    expect(res.status).toBe(403);
  });

  test("KV data is scoped per agent", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Both agents write to the same key name
    await authFetch(fetch, "/agent-alpha/kv", {
      key: "key-alpha",
      body: { op: "set", key: "shared-key", value: "alpha-value" },
    });

    await authFetch(fetch, "/agent-beta/kv", {
      key: "key-beta",
      body: { op: "set", key: "shared-key", value: "beta-value" },
    });

    // Each agent reads its own value — no cross-contamination
    const alphaGet = await authFetch(fetch, "/agent-alpha/kv", {
      key: "key-alpha",
      body: { op: "get", key: "shared-key" },
    });
    const alphaResult = (await alphaGet.json()) as { result: string };
    expect(alphaResult.result).toBe("alpha-value");

    const betaGet = await authFetch(fetch, "/agent-beta/kv", {
      key: "key-beta",
      body: { op: "get", key: "shared-key" },
    });
    const betaResult = (await betaGet.json()) as { result: string };
    expect(betaResult.result).toBe("beta-value");
  });
});

// ── Cross-Agent Auth Isolation ─────────────────────────────────────────

describe("cross-agent auth isolation", () => {
  test("agent A's key cannot deploy to agent B's slug", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Alpha's key tries to redeploy over beta
    const res = await fetch("/agent-beta/deploy", {
      method: "POST",
      headers: authHeaders("key-alpha"),
      body: deployBody(),
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

    // Use wrong key — error message should not confirm agent exists
    const res = await fetch("/agent-alpha/deploy", {
      method: "POST",
      headers: authHeaders("wrong-key"),
      body: deployBody(),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    // Message should be generic, not "agent-alpha is owned by someone else"
    expect(body.error).toBe("Forbidden");
    expect(body.error).not.toContain("agent-alpha");
    expect(body.error).not.toContain("owned");
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
      agentConfig: TEST_AGENT_CONFIG,
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

    // Both agents have separate manifests
    const alphaManifest = await store.getManifest("agent-alpha");
    const betaManifest = await store.getManifest("agent-beta");

    expect(alphaManifest).not.toBeNull();
    expect(betaManifest).not.toBeNull();
    expect(alphaManifest?.slug).toBe("agent-alpha");
    expect(betaManifest?.slug).toBe("agent-beta");
  });

  test("redeploying agent A does not affect agent B's data", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Store data in beta's KV
    await authFetch(fetch, "/agent-beta/kv", {
      key: "key-beta",
      body: { op: "set", key: "persist-test", value: "should-survive" },
    });

    // Redeploy agent alpha
    await fetch("/agent-alpha/deploy", {
      method: "POST",
      headers: authHeaders("key-alpha"),
      body: deployBody(),
    });

    // Beta's KV data should still be intact
    const betaRead = await fetch("/agent-beta/kv?key=persist-test", {
      headers: { Authorization: "Bearer key-beta" },
    });
    expect(betaRead.status).toBe(200);
    expect(await betaRead.json()).toBe("should-survive");
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
    const betaManifest = await store.getManifest("agent-beta");
    expect(betaManifest).not.toBeNull();
    expect(betaManifest?.slug).toBe("agent-beta");
  });
});
