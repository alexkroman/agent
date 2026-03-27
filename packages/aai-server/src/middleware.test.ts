// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  createTestKvStore,
  createTestOrchestrator,
  createTestScopeKey,
  createTestStore,
  deployAgent,
} from "./_test-utils.ts";
import { hashApiKey } from "./auth.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { signScopeToken } from "./scope-token.ts";

test("orchestrator adds Cross-Origin-Isolation headers", async () => {
  const store = createTestStore();
  const scopeKey = await createTestScopeKey();
  const kvStore = createTestKvStore();
  const app = createOrchestrator({ slots: new Map(), store, scopeKey, kvStore });
  const res = await app.fetch(new Request("http://localhost/health"));
  expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
});

test("orchestrator returns 401 on deploy without auth", async () => {
  const store = createTestStore();
  const scopeKey = await createTestScopeKey();
  const kvStore = createTestKvStore();
  const app = createOrchestrator({ slots: new Map(), store, scopeKey, kvStore });
  const res = await app.fetch(new Request("http://localhost/my-agent/deploy", { method: "POST" }));
  expect(res.status).toBe(401);
});

describe("validateSlug", () => {
  test("rejects invalid slug format", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/INVALID/health");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid slug");
  });

  test("rejects single character slug", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/a/health");
    expect(res.status).toBe(400);
  });

  test("accepts valid slug with hyphens and underscores", async () => {
    const { fetch } = await createTestOrchestrator();
    // Will be 404 (no agent deployed) but not 400 (slug is valid)
    const res = await fetch("/my-test_agent/health");
    expect(res.status).toBe(404);
  });
});

describe("requireOwner", () => {
  test("returns 401 without Authorization header", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/my-agent/deploy", { method: "POST" });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Missing Authorization");
  });

  test("returns 403 when key does not match agent owner", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "owner-key");
    const res = await fetch("/my-agent/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ worker: "x", clientFiles: {} }),
    });
    expect(res.status).toBe(403);
  });
});

describe("requireScopeToken", () => {
  test("returns 401 without token on KV endpoint", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await fetch("/my-agent/kv", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": "127.0.0.1",
      },
      body: JSON.stringify({ op: "get", key: "test" }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 with invalid token", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await fetch("/my-agent/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-token",
        "Content-Type": "application/json",
        "cf-connecting-ip": "127.0.0.1",
      },
      body: JSON.stringify({ op: "get", key: "test" }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Invalid or tampered");
  });

  test("accepts valid scope token", async () => {
    const { fetch, scopeKey } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const keyHash = await hashApiKey("key1");
    const token = await signScopeToken(scopeKey, { keyHash, slug: "my-agent" });
    const res = await fetch("/my-agent/kv", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "cf-connecting-ip": "127.0.0.1",
      },
      body: JSON.stringify({ op: "get", key: "test" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("requireUpgrade", () => {
  test("slug without trailing slash redirects", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/my-agent", { redirect: "manual" });
    expect(res.status).toBe(301);
  });
});
