// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { invalidateApiKeyOwner, requireOwner, resolveBearer } from "./middleware.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import { apiKeyOwnerSecretName } from "./supabase-auth.ts";
import {
  authFetch,
  createTestOrchestrator,
  createTestStore,
  deploy,
  deployAgent,
} from "./test-utils.ts";

test("orchestrator adds Cross-Origin-Isolation headers", async () => {
  const store = createTestStore();
  const { app } = createOrchestrator({
    slots: createSlotCache(),
    store,
  });
  const res = await app.fetch(new Request("http://localhost/health"));
  expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
});

test("orchestrator returns 401 on deploy without auth", async () => {
  const store = createTestStore();
  const { app } = createOrchestrator({
    slots: createSlotCache(),
    store,
  });
  const res = await app.fetch(new Request("http://localhost/deploy", { method: "POST" }));
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

describe("deploy route auth", () => {
  test("returns 401 without Authorization header", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/deploy", { method: "POST" });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Missing Authorization");
  });

  test("returns 403 when key does not match agent owner", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "owner-key");
    const res = await deploy(fetch, { key: "wrong-key", body: { slug: "my-agent" } });
    expect(res.status).toBe(403);
  });
});

describe("resolveBearer raw-key owner mapping", () => {
  const req = (key: string) =>
    new Request("http://localhost/", { headers: { Authorization: `Bearer ${key}` } });

  test("a raw key resolves the stored key→user mapping; unmapped keys don't", async () => {
    const secrets = createMemorySecretStore();
    await secrets.put(apiKeyOwnerSecretName("linked-key"), "user-1");
    expect(await resolveBearer(req("linked-key"), { secrets })).toEqual({
      apiKey: "linked-key",
      userId: "user-1",
    });
    expect(await resolveBearer(req("stranger-key"), { secrets })).toEqual({
      apiKey: "stranger-key",
    });
  });

  test("negative lookups are cached; invalidation makes a new mapping visible", async () => {
    const secrets = createMemorySecretStore();
    // Prime the negative cache, then store the mapping (onboarding).
    expect(await resolveBearer(req("late-key"), { secrets })).toEqual({ apiKey: "late-key" });
    await secrets.put(apiKeyOwnerSecretName("late-key"), "user-2");
    // Still the cached negative until the writing replica invalidates.
    expect(await resolveBearer(req("late-key"), { secrets })).toEqual({ apiKey: "late-key" });
    invalidateApiKeyOwner(secrets, "late-key");
    expect(await resolveBearer(req("late-key"), { secrets })).toEqual({
      apiKey: "late-key",
      userId: "user-2",
    });
  });
});

describe("requireOwner unclaimed-slug paths", () => {
  const bearerReq = () =>
    new Request("http://localhost/", { headers: { Authorization: "Bearer some-key" } });

  test("throws 404 for a nonexistent slug on data routes", async () => {
    const store = createTestStore();
    await expect(
      requireOwner(bearerReq(), { slug: "ghost-agent", store, secrets: createMemorySecretStore() }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

/**
 * `existingOwnerMw` through a real ROUTE, which is a different claim from the
 * function-level specs above: those say `requireOwner` decides correctly, these say
 * it is actually mounted and that its rejection becomes a status.
 *
 * The route used to be `GET /:slug/storage`, which is gone with tenant databases.
 * `GET /:slug/secret` carries the same middleware and is likewise a read, so the
 * wiring stays covered — the point was never the endpoint.
 */
describe("existingOwnerMw through a mounted route", () => {
  test("returns 401 without auth", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await fetch("/my-agent/secret", { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("accepts a valid owner API key", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await authFetch(fetch, "/my-agent/secret", { method: "GET" });
    expect(res.status).toBe(200);
  });
});
