// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { localSlugLock, type SlugMutationLock } from "./platform-lock.ts";
import { authFetch, createTestOrchestrator, deploy, deployAgent } from "./test-utils.ts";

test("concurrent deploy and delete are serialized", async () => {
  // The claim is EXCLUSION, so the lock is what the test has to watch. The
  // final-state check alone cannot see it: `record === null || record.slug ===
  // "my-agent"` holds for every interleaving, torn ones included, so removing
  // the lock from both routes left this file green.
  let live = 0;
  /** Concurrent holders of the slug lock, sampled on entry and on exit. */
  const holders: number[] = [];
  const slugLock: SlugMutationLock = (slug, fn) =>
    localSlugLock(slug, async () => {
      live += 1;
      holders.push(live);
      try {
        // Yield inside the critical section so the other mutation gets a turn
        // to run if nothing is holding it back — without this, the two could
        // serialize by accident on the event loop and prove nothing.
        await new Promise((resolve) => setImmediate(resolve));
        return await fn();
      } finally {
        holders.push(live);
        live -= 1;
      }
    });

  const { fetch, store } = await createTestOrchestrator({ slugLock });
  await deployAgent(fetch);

  // Verify the agent exists before the race
  expect(await store.getAgent("my-agent")).not.toBeNull();
  // The setup deploy took the lock too; the race is what this counts.
  holders.length = 0;

  // Fire deploy and delete concurrently for the same slug.
  // Without the shared lock the delete could run mid-deploy, corrupting state.
  const [deployResp, deleteResp] = await Promise.all([
    deploy(fetch, { body: { slug: "my-agent" } }),
    authFetch(fetch, "/my-agent", { method: "DELETE" }),
  ]);

  expect(deployResp.status).toBe(200);
  expect(deleteResp.status).toBe(200);

  // Both mutations really took the lock (a route that stopped taking it would
  // record nothing), and neither ever saw a second holder.
  expect(holders).toEqual([1, 1, 1, 1]);

  // Whichever acquired the lock first wins — the important thing is no
  // crash / corruption. The final state depends on execution order:
  // deploy-then-delete → null, delete-then-deploy → record exists.
  const record = await store.getAgent("my-agent");
  if (record === null) {
    // The delete ran second: nothing of the deploy survives it.
    expect(await store.getWorkerCode("my-agent")).toBeNull();
  } else {
    // The deploy ran second, so its bundle is whole — not a half-written row
    // pointing at a blob the interleaved delete swept.
    expect(record.slug).toBe("my-agent");
    expect(await store.getWorkerCode("my-agent")).toContain("test-agent");
  }
});

test("concurrent deletes don't throw", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);

  const [r1, r2] = await Promise.all([
    authFetch(fetch, "/my-agent", { method: "DELETE" }),
    authFetch(fetch, "/my-agent", { method: "DELETE" }),
  ]);

  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
});
