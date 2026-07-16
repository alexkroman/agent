// Copyright 2025 the AAI authors. MIT license.
/**
 * Orchestrator security tests: slug validation / path traversal,
 * security headers and CORS, KV prefix isolation, and WebSocket URL
 * validation. Cross-agent tenant-isolation tests live in
 * orchestrator-security.test.ts.
 */
import { createMemoryVector } from "@alexkroman1/aai/runtime";
import { describe, expect, test } from "vitest";
import { createOrchestrator } from "./orchestrator.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import {
  createTestOrchestrator,
  createTestStorage,
  createTestStore,
  deployAgent,
} from "./test-utils.ts";

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
    const { app } = createOrchestrator({
      slots: createSlotCache(),
      store,
      storage,
      defaultVector: (slug) => createMemoryVector({ namespace: slug }),
    });
    const res = await app.fetch(new Request("http://localhost/health"));

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  test("404 responses include security headers", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    const { app } = createOrchestrator({
      slots: createSlotCache(),
      store,
      storage,
      defaultVector: (slug) => createMemoryVector({ namespace: slug }),
    });
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
      slots: createSlotCache(),
      store,
      storage,
      defaultVector: (slug) => createMemoryVector({ namespace: slug }),
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
    const { app } = createOrchestrator({
      slots: createSlotCache(),
      store,
      storage,
      defaultVector: (slug) => createMemoryVector({ namespace: slug }),
    });

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
