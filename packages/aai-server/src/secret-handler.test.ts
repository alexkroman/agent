// Copyright 2025 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { expect, test } from "vitest";
import { createTestOrchestrator, type TestFetch } from "./_orchestrator-test-utils.ts";
import { authFetch, deployAgent } from "./_request-test-utils.ts";
import { MAX_ENV_SIZE } from "./constants.ts";
import { envSize } from "./env-size.ts";
import { MAX_SECRET_BODY_BYTES } from "./secret-handler.ts";

async function deployAndAuth() {
  const orch = await createTestOrchestrator();
  await deployAgent(orch.fetch);
  return orch;
}

/**
 * Owner-auth'd request to the secret route of the agent every spec deploys.
 * A `body` is JSON-encoded; omitting it sends none.
 */
function secretReq(fetch: TestFetch, method: string, body?: unknown): Promise<Response> {
  return authFetch(fetch, "/my-agent/secret", {
    method,
    ...omitUndefined({ body }),
  });
}

test("secret list rejects without auth", async () => {
  const { fetch } = await deployAndAuth();
  expect((await fetch("/my-agent/secret")).status).toBe(401);
});

test("secret list returns var names for deployed agent", async () => {
  const { fetch } = await deployAndAuth();
  const res = await secretReq(fetch, "GET");
  expect(res.status).toBe(200);
  // The standard test deploy seeds the AssemblyAI key (VALID_ENV).
  expect(((await res.json()) as Record<string, unknown>).vars).toEqual(["ASSEMBLYAI_API_KEY"]);
});

test("secret set rejects without auth", async () => {
  const { fetch } = await deployAndAuth();
  expect(
    (
      await fetch("/my-agent/secret", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ MY_KEY: "secret" }),
      })
    ).status,
  ).toBe(401);
});

test("secret set merges new vars", async () => {
  const { fetch } = await deployAndAuth();
  const setRes = await secretReq(fetch, "PUT", { MY_KEY: "secret" });
  expect(setRes.status).toBe(200);
  const setBody = (await setRes.json()) as Record<string, unknown>;
  expect(setBody.ok).toBe(true);
  expect((setBody.keys as string[]).sort((a, b) => a.localeCompare(b))).toEqual([
    "ASSEMBLYAI_API_KEY",
    "MY_KEY",
  ]);
});

test("secret set rejects non-object body", async () => {
  const { fetch } = await deployAndAuth();
  expect((await secretReq(fetch, "PUT", ["not", "an", "object"])).status).toBe(400);
});

test("secret set rejects non-string values", async () => {
  const { fetch } = await deployAndAuth();
  expect((await secretReq(fetch, "PUT", { NUM: 123 })).status).toBe(400);
});

test("secret delete rejects without auth", async () => {
  const { fetch } = await deployAndAuth();
  expect((await fetch("/my-agent/secret/ASSEMBLYAI_API_KEY", { method: "DELETE" })).status).toBe(
    401,
  );
});

test("secret delete removes a key", async () => {
  const { fetch } = await deployAndAuth();
  await secretReq(fetch, "PUT", { EXTRA: "val" });
  const delRes = await authFetch(fetch, "/my-agent/secret/EXTRA", { method: "DELETE" });
  expect(delRes.status).toBe(200);
  expect(((await delRes.json()) as Record<string, unknown>).ok).toBe(true);
  const listRes = await secretReq(fetch, "GET");
  expect(((await listRes.json()) as Record<string, unknown>).vars).toEqual(["ASSEMBLYAI_API_KEY"]);
});

test("secret set allows overwriting ASSEMBLYAI_API_KEY", async () => {
  const { fetch } = await deployAndAuth();
  const res = await secretReq(fetch, "PUT", { ASSEMBLYAI_API_KEY: "new-key" });
  expect(res.status).toBe(200);
  const listRes = await secretReq(fetch, "GET");
  expect(((await listRes.json()) as Record<string, unknown>).vars).toContain("ASSEMBLYAI_API_KEY");
});

test("secret delete allows removing ASSEMBLYAI_API_KEY", async () => {
  const { fetch } = await deployAndAuth();
  const res = await authFetch(fetch, "/my-agent/secret/ASSEMBLYAI_API_KEY", { method: "DELETE" });
  expect(res.status).toBe(200);
});

test("secret delete returns 404 for unknown agent", async () => {
  const { fetch } = await deployAndAuth();
  const res = await authFetch(fetch, "/nonexistent/secret/KEY", { method: "DELETE" });
  expect(res.status).toBe(404);
});

// ── the MAX_ENV_SIZE cap ───────────────────────────────────────────────────
// The store refuses an over-size merge before writing anything; the refusal
// is a typed error the error handler answers 413 (it was a 500).

/** A one-name update whose merge onto the deployed env is exactly `size` bytes. */
async function updateMergingTo(
  store: { getEnv(slug: string): Promise<Record<string, string> | null> },
  size: number,
): Promise<Record<string, string>> {
  const existing = (await store.getEnv("my-agent")) ?? {};
  return { BIG: "x".repeat(size - envSize({ ...existing, BIG: "" })) };
}

test("secret set whose merge is exactly MAX_ENV_SIZE is stored", async () => {
  const { fetch, store } = await deployAndAuth();
  const update = await updateMergingTo(store, MAX_ENV_SIZE);
  expect((await secretReq(fetch, "PUT", update)).status).toBe(200);
  expect((await store.getEnv("my-agent"))?.BIG).toBe(update.BIG);
});

test("secret set one byte over MAX_ENV_SIZE is 413 with the byte counts, env untouched", async () => {
  const { fetch, store } = await deployAndAuth();
  const before = await store.getEnv("my-agent");
  const res = await secretReq(fetch, "PUT", await updateMergingTo(store, MAX_ENV_SIZE + 1));
  expect(res.status).toBe(413);
  const { error } = (await res.json()) as { error: string };
  expect(error).toContain(`${MAX_ENV_SIZE + 1} bytes`);
  expect(error).toContain(`${MAX_ENV_SIZE}-byte limit`);
  expect(error).not.toContain("xxxx");
  expect(await store.getEnv("my-agent")).toEqual(before);
});

test("secret set measures the MERGE: an update that fits alone but not onto the env is 413", async () => {
  const { fetch, store } = await deployAndAuth();
  const half = "y".repeat(MAX_ENV_SIZE / 2);
  expect((await secretReq(fetch, "PUT", { A: half })).status).toBe(200);
  expect((await secretReq(fetch, "PUT", { B: half })).status).toBe(413);
  expect(Object.keys((await store.getEnv("my-agent")) ?? {}).sort()).toEqual([
    "A",
    "ASSEMBLYAI_API_KEY",
  ]);
});

test("a secret-set body past the body limit is 413 before it is parsed", async () => {
  const { fetch } = await deployAndAuth();
  const res = await secretReq(fetch, "PUT", { A: "z".repeat(MAX_SECRET_BODY_BYTES) });
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: "Request body too large" });
});
