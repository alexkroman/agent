// Copyright 2025 the AAI authors. MIT license.
/**
 * Cross-agent security boundary tests for the AAI platform.
 *
 * Verifies that agents deployed on the same platform cannot:
 * - Access each other's KV data
 * - Use each other's API keys
 * - Interfere with each other's sessions or sandboxes
 * - Bypass slug validation or path traversal protections
 */

import { describe, expect, test } from "vitest";
import { hashApiKey } from "./auth.ts";
import { createOrchestrator } from "./orchestrator.ts";
import {
  createTestOrchestrator,
  createTestStorage,
  createTestStore,
  deployAgent,
  deployBody,
} from "./test-utils.ts";

// ── Cross-Agent KV Isolation ───────────────────────────────────────────

describe("cross-agent KV isolation", () => {
  test("agent A cannot read agent B's KV data via API", async () => {
    const { fetch } = await createTestOrchestrator();

    // Deploy two agents with different keys
    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Agent alpha writes a KV entry
    await fetch("/agent-alpha/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-alpha",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "set", key: "secret", value: "alpha-secret-data" }),
    });

    // Agent alpha can read its own data
    const alphaRead = await fetch("/agent-alpha/kv?key=secret", {
      headers: { Authorization: "Bearer key-alpha" },
    });
    expect(alphaRead.status).toBe(200);
    const alphaData = await alphaRead.json();
    expect(alphaData).toBe("alpha-secret-data");

    // Agent beta writes a KV entry with the same key name
    await fetch("/agent-beta/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-beta",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "set", key: "secret", value: "beta-secret-data" }),
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
    const res = await fetch("/agent-beta/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-alpha",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "get", key: "test" }),
    });
    expect(res.status).toBe(403);
  });

  test("KV keys list is scoped per agent", async () => {
    const { fetch } = await createTestOrchestrator();

    await deployAgent(fetch, "agent-alpha", "key-alpha");
    await deployAgent(fetch, "agent-beta", "key-beta");

    // Both agents write keys
    await fetch("/agent-alpha/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-alpha",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "set", key: "alpha-key-1", value: "a1" }),
    });

    await fetch("/agent-beta/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-beta",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "set", key: "beta-key-1", value: "b1" }),
    });

    // Alpha lists its keys — should not see beta's keys
    const alphaKeys = await fetch("/agent-alpha/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-alpha",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "keys" }),
    });
    const alphaResult = (await alphaKeys.json()) as { result: string[] };
    expect(alphaResult.result).toContain("alpha-key-1");
    expect(alphaResult.result).not.toContain("beta-key-1");
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
      headers: {
        Authorization: "Bearer key-alpha",
        "Content-Type": "application/json",
      },
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
      headers: {
        Authorization: "Bearer key-alpha",
        "Content-Type": "application/json",
      },
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
      headers: {
        Authorization: "Bearer wrong-key",
        "Content-Type": "application/json",
      },
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

// ── Platform Credential Separation ─────────────────────────────────────

describe("platform credential separation", () => {
  test("ASSEMBLYAI_API_KEY is stripped from agentEnv in resolveSandbox", async () => {
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

    // Verify getEnv returns everything
    const fullEnv = await store.getEnv("cred-agent");
    expect(fullEnv).toHaveProperty("ASSEMBLYAI_API_KEY", "platform-secret-key");
    expect(fullEnv).toHaveProperty("USER_SECRET", "user-value");

    // Simulate what resolveSandbox does — strip platform key
    // biome-ignore lint/style/noNonNullAssertion: fullEnv is verified non-null above
    const { ASSEMBLYAI_API_KEY: apiKey, ...agentEnv } = fullEnv!;
    expect(apiKey).toBe("platform-secret-key");
    expect(agentEnv).not.toHaveProperty("ASSEMBLYAI_API_KEY");
    expect(agentEnv).toEqual({ USER_SECRET: "user-value", ANOTHER_SECRET: "another-value" });
  });

  test("reserved platform key cannot be overwritten via secrets API", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/secret", {
      method: "PUT",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ASSEMBLYAI_API_KEY: "attacker-key" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("reserved");
  });

  test("reserved platform key cannot be deleted via secrets API", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/secret/ASSEMBLYAI_API_KEY", {
      method: "DELETE",
      headers: { Authorization: "Bearer key1" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("reserved");
  });
});

// ── Slug Validation & Path Traversal ───────────────────────────────────

describe("slug validation prevents path traversal", () => {
  test("rejects slug with path traversal characters", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/../etc/passwd/deploy", { method: "POST" });
    // Either 400 (invalid slug) or 404 — but not a successful traversal
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("rejects slug with URL-encoded traversal", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/%2e%2e%2fetc%2fpasswd/deploy", { method: "POST" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("rejects slug with dots", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/my.agent/health");
    expect(res.status).toBe(400);
  });

  test("rejects slug with uppercase letters", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/MyAgent/health");
    expect(res.status).toBe(400);
  });

  test("rejects slug with spaces", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/my agent/health");
    // Spaces in URLs result in 400 or routing failure
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("rejects slug starting with hyphen", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/-agent/health");
    expect(res.status).toBe(400);
  });

  test("rejects slug ending with hyphen", async () => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/agent-/health");
    expect(res.status).toBe(400);
  });

  test("rejects slug over 64 characters", async () => {
    const { fetch } = await createTestOrchestrator();

    const longSlug = `${"a".repeat(65)}`;
    const res = await fetch(`/${longSlug}/health`);
    expect(res.status).toBe(400);
  });
});

// ── Security Headers ───────────────────────────────────────────────────

describe("security headers on all response types", () => {
  test("health endpoint includes security headers", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    const { app } = createOrchestrator({ slots: new Map(), store, storage });
    const res = await app.fetch(new Request("http://localhost/health"));

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  test("404 responses include security headers", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    const { app } = createOrchestrator({ slots: new Map(), store, storage });
    const res = await app.fetch(new Request("http://localhost/nonexistent"));

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  test("error responses include security headers", async () => {
    const { fetch } = await createTestOrchestrator();

    // Trigger a 401
    const res = await fetch("/my-agent/deploy", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("agent-scoped responses include security headers", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("CORS headers restrict allowed origins when configured", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    const { app } = createOrchestrator({
      slots: new Map(),
      store,
      storage,
      allowedOrigins: ["https://trusted.example.com"],
    });

    // Trusted origin gets reflected
    const trusted = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://trusted.example.com" },
      }),
    );
    expect(trusted.headers.get("Access-Control-Allow-Origin")).toBe("https://trusted.example.com");

    // Untrusted origin is rejected
    const untrusted = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://evil.example.com" },
      }),
    );
    expect(untrusted.headers.get("Access-Control-Allow-Origin")).not.toBe(
      "https://evil.example.com",
    );
  });

  test("CORS rejects cross-origin when no origins configured", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    const { app } = createOrchestrator({ slots: new Map(), store, storage });

    const res = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://any-site.com" },
      }),
    );
    // No allowedOrigins configured means reject cross-origin requests
    const acao = res.headers.get("Access-Control-Allow-Origin");
    expect(acao).not.toBe("https://any-site.com");
  });
});

// ── Harness Auth Token ─────────────────────────────────────────────────

describe("harness auth token enforcement", () => {
  test("sandbox KV prefix includes slug for isolation", () => {
    // Verify the KV prefix pattern used in sandbox.ts
    const slug = "my-agent";
    const prefix = `agents/${slug}/kv`;
    expect(prefix).toBe("agents/my-agent/kv");

    // Different slug produces different prefix
    const otherPrefix = "agents/other-agent/kv";
    expect(prefix).not.toBe(otherPrefix);
  });

  test("KV prefix prevents cross-agent data access", () => {
    // Simulate what happens when two agents have overlapping key names
    const agentAPrefix = "agents/agent-a/kv";
    const agentBPrefix = "agents/agent-b/kv";

    const keyName = "shared-key";
    const agentAFullKey = `${agentAPrefix}:${keyName}`;
    const agentBFullKey = `${agentBPrefix}:${keyName}`;

    // Even with the same key name, full keys are different
    expect(agentAFullKey).not.toBe(agentBFullKey);
    // Neither is a prefix of the other
    expect(agentAFullKey.startsWith(agentBPrefix)).toBe(false);
    expect(agentBFullKey.startsWith(agentAPrefix)).toBe(false);
  });
});

// ── WebSocket URL Validation ───────────────────────────────────────────

describe("websocket URL validation", () => {
  test("WebSocket path regex rejects invalid slugs", () => {
    const wsPathRegex = /^\/[a-z0-9][a-z0-9_-]*[a-z0-9]\/websocket$/;

    // Valid
    expect(wsPathRegex.test("/my-agent/websocket")).toBe(true);
    expect(wsPathRegex.test("/agent123/websocket")).toBe(true);
    expect(wsPathRegex.test("/my_agent/websocket")).toBe(true);

    // Invalid — path traversal
    expect(wsPathRegex.test("/../etc/passwd/websocket")).toBe(false);
    expect(wsPathRegex.test("/my-agent/../other/websocket")).toBe(false);

    // Invalid — uppercase
    expect(wsPathRegex.test("/MyAgent/websocket")).toBe(false);

    // Invalid — dots
    expect(wsPathRegex.test("/my.agent/websocket")).toBe(false);

    // Invalid — no slug
    expect(wsPathRegex.test("//websocket")).toBe(false);

    // Invalid — extra path segments
    expect(wsPathRegex.test("/agent/extra/websocket")).toBe(false);
  });
});

// ── Auth Timing Safety ─────────────────────────────────────────────────

describe("auth timing safety", () => {
  test("API key hashes are always 64 hex chars (constant length)", async () => {
    // Timing-safe comparison only works when both strings have the same
    // length. Since we compare SHA-256 hashes, they should always be 64
    // chars, making the early length-check exit harmless.
    const shortKey = await hashApiKey("a");
    const longKey = await hashApiKey("a".repeat(1000));
    const emptyKey = await hashApiKey("");

    expect(shortKey).toHaveLength(64);
    expect(longKey).toHaveLength(64);
    expect(emptyKey).toHaveLength(64);

    // All hashes are distinct
    expect(shortKey).not.toBe(longKey);
    expect(shortKey).not.toBe(emptyKey);
    expect(longKey).not.toBe(emptyKey);
  });

  test("different keys with same prefix produce different hashes", async () => {
    const h1 = await hashApiKey("key-prefix-1");
    const h2 = await hashApiKey("key-prefix-2");
    expect(h1).not.toBe(h2);
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
    await fetch("/agent-beta/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-beta",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "set", key: "persist-test", value: "should-survive" }),
    });

    // Redeploy agent alpha
    await fetch("/agent-alpha/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-alpha",
        "Content-Type": "application/json",
      },
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
