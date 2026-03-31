// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  createTestOrchestrator,
  createTestStorage,
  createTestStore,
  deployAgent,
} from "./lib/test-utils.ts";
import { createOrchestrator } from "./orchestrator.ts";

test("orchestrator adds Cross-Origin-Isolation headers", async () => {
  const store = createTestStore();
  const storage = createTestStorage();
  const { app } = createOrchestrator({ slots: new Map(), store, storage });
  const res = await app.fetch(new Request("http://localhost/health"));
  expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
});

test("orchestrator returns 401 on deploy without auth", async () => {
  const store = createTestStore();
  const storage = createTestStorage();
  const { app } = createOrchestrator({ slots: new Map(), store, storage });
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

describe("requireOwner on KV endpoint", () => {
  test("returns 401 without auth on KV endpoint", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await fetch("/my-agent/kv", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "get", key: "test" }),
    });
    expect(res.status).toBe(401);
  });

  test("accepts valid owner API key on KV endpoint", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await fetch("/my-agent/kv", {
      method: "POST",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
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
