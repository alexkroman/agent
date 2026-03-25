// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { createTestOrchestrator, deployAgent } from "./_test-utils.ts";

async function deployAndAuth(slug = "my-agent", key = "key1") {
  const orch = await createTestOrchestrator();
  await deployAgent(orch.fetch, slug, key);
  return { ...orch, key };
}

function secretReq(
  slug: string,
  key: string,
  method: string,
  body?: unknown,
): [string, RequestInit] {
  return [
    `/${slug}/secret`,
    {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  ];
}

test("secret list rejects without auth", async () => {
  const { fetch } = await deployAndAuth();
  expect((await fetch("/my-agent/secret")).status).toBe(401);
});

test("secret list returns var names for deployed agent", async () => {
  const { fetch, key } = await deployAndAuth();
  const res = await fetch(...secretReq("my-agent", key, "GET"));
  expect(res.status).toBe(200);
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
  const { fetch, key } = await deployAndAuth();
  const setRes = await fetch(...secretReq("my-agent", key, "PUT", { MY_KEY: "secret" }));
  expect(setRes.status).toBe(200);
  const setBody = (await setRes.json()) as Record<string, unknown>;
  expect(setBody.ok).toBe(true);
  expect((setBody.keys as string[]).sort()).toEqual(["ASSEMBLYAI_API_KEY", "MY_KEY"]);
});

test("secret set rejects non-object body", async () => {
  const { fetch, key } = await deployAndAuth();
  expect((await fetch(...secretReq("my-agent", key, "PUT", ["not", "an", "object"]))).status).toBe(
    400,
  );
});

test("secret set rejects non-string values", async () => {
  const { fetch, key } = await deployAndAuth();
  expect((await fetch(...secretReq("my-agent", key, "PUT", { NUM: 123 }))).status).toBe(400);
});

test("secret delete rejects without auth", async () => {
  const { fetch } = await deployAndAuth();
  expect((await fetch("/my-agent/secret/ASSEMBLYAI_API_KEY", { method: "DELETE" })).status).toBe(
    401,
  );
});

test("secret delete removes a key", async () => {
  const { fetch, key } = await deployAndAuth();
  await fetch(...secretReq("my-agent", key, "PUT", { EXTRA: "val" }));
  const delRes = await fetch("/my-agent/secret/EXTRA", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` },
  });
  expect(delRes.status).toBe(200);
  expect(((await delRes.json()) as Record<string, unknown>).ok).toBe(true);
  const listRes = await fetch(...secretReq("my-agent", key, "GET"));
  expect(((await listRes.json()) as Record<string, unknown>).vars).toEqual(["ASSEMBLYAI_API_KEY"]);
});

test("secret delete returns 404 for unknown agent", async () => {
  const { fetch, key } = await deployAndAuth();
  expect(
    (
      await fetch("/nonexistent/secret/KEY", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      })
    ).status,
  ).toBe(404);
});
