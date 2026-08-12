// Copyright 2025 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { expect, test } from "vitest";
import { authFetch, createTestOrchestrator, deployAgent, type TestFetch } from "./test-utils.ts";

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
