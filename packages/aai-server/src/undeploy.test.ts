// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { createTestOrchestrator, deployAgent } from "./_test-utils.ts";

test("undeploy returns 200 for deployed agent", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);

  const resp = await fetch("/my-agent/undeploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1" },
  });

  expect(resp.status).toBe(200);
  const body = (await resp.json()) as Record<string, unknown>;
  expect(body).toEqual({ ok: true, message: "Undeployed my-agent" });
});

test("undeploy removes agent from store", async () => {
  const { fetch, store } = await createTestOrchestrator();
  await deployAgent(fetch);

  await fetch("/my-agent/undeploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1" },
  });

  const manifest = await store.getManifest("my-agent");
  expect(manifest).toBeNull();
});

test("undeploy returns 401 without auth", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);

  const resp = await fetch("/my-agent/undeploy", {
    method: "POST",
  });

  expect(resp.status).toBe(401);
});
