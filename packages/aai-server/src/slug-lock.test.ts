// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { createTestOrchestrator, deployAgent, deployBody } from "./lib/test-utils.ts";

test("concurrent deploy and delete are serialized", async () => {
  const { fetch, store } = await createTestOrchestrator();
  await deployAgent(fetch);

  // Verify the agent exists before the race
  expect(await store.getManifest("my-agent")).not.toBeNull();

  // Fire deploy and delete concurrently for the same slug.
  // Without the shared lock the delete could run mid-deploy, corrupting state.
  const [deployResp, deleteResp] = await Promise.all([
    fetch("/my-agent/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: deployBody(),
    }),
    fetch("/my-agent", {
      method: "DELETE",
      headers: { Authorization: "Bearer key1" },
    }),
  ]);

  expect(deployResp.status).toBe(200);
  expect(deleteResp.status).toBe(200);

  // Whichever acquired the lock first wins — the important thing is no
  // crash / corruption. The final state depends on execution order:
  // deploy-then-delete → null, delete-then-deploy → manifest exists.
  const manifest = await store.getManifest("my-agent");
  expect(manifest === null || manifest.slug === "my-agent").toBe(true);
});

test("concurrent deletes don't throw", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);

  const [r1, r2] = await Promise.all([
    fetch("/my-agent", {
      method: "DELETE",
      headers: { Authorization: "Bearer key1" },
    }),
    fetch("/my-agent", {
      method: "DELETE",
      headers: { Authorization: "Bearer key1" },
    }),
  ]);

  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
});
