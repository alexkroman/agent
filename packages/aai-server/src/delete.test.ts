// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { createTestOrchestrator, deployAgent } from "./_test-utils.ts";

test("delete returns 200 for deployed agent", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);

  const resp = await fetch("/my-agent", {
    method: "DELETE",
    headers: { Authorization: "Bearer key1" },
  });

  expect(resp.status).toBe(200);
  const body = (await resp.json()) as Record<string, unknown>;
  expect(body).toEqual({ ok: true, message: "Deleted my-agent" });
});

test("delete removes agent from store", async () => {
  const { fetch, store } = await createTestOrchestrator();
  await deployAgent(fetch);

  await fetch("/my-agent", {
    method: "DELETE",
    headers: { Authorization: "Bearer key1" },
  });

  const manifest = await store.getManifest("my-agent");
  expect(manifest).toBeNull();
});

test("delete returns 401 without auth", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);

  const resp = await fetch("/my-agent", {
    method: "DELETE",
  });

  expect(resp.status).toBe(401);
});
