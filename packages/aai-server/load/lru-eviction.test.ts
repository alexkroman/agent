// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: LRU Slot Eviction
 *
 * Fills all MAX_SLOTS with active agents, then deploys one more.
 * Verifies the server evicts the least-recently-used slot
 * instead of rejecting the new connection.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkHealth, closeAll, openConnections, sampleMemory } from "./helpers.ts";
import { DEPLOY_KEY, deployTestAgent, type LoadEnv, startLoadEnv } from "./setup.ts";

let env: LoadEnv;

beforeAll(async () => {
  // MAX_SLOTS=2 keeps test fast (fewer isolates to boot)
  env = await startLoadEnv({ MAX_SLOTS: "2" });
}, 180_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe("LRU slot eviction", () => {
  test("server evicts LRU slot when at capacity", async () => {
    const allConnections: import("ws").default[] = [];

    try {
      // Fill both slots sequentially (isolate boot is slow ~10-20s each)
      for (let i = 0; i < 2; i++) {
        const slug = `lru-agent-${i}`;
        await deployTestAgent(env.serverUrl, slug, DEPLOY_KEY);
        const { opened } = await openConnections(env.wsUrl, slug, 1, 30_000);
        allConnections.push(...opened);

        const mem = sampleMemory(env.containerId);
        console.log(
          `Agent ${slug}: ${opened.length > 0 ? "connected" : "failed"}, memory ${mem.percent.toFixed(1)}%`,
        );
        expect(opened.length).toBe(1);
      }

      console.log("Both slots filled");

      // Close connection to agent-0 so it becomes the LRU candidate
      if (allConnections[0]) {
        allConnections[0].close();
        allConnections.shift();
      }
      await new Promise((r) => setTimeout(r, 2000));

      // Deploy a 3rd agent — should evict agent-0's slot via LRU
      const extraSlug = "lru-extra";
      await deployTestAgent(env.serverUrl, extraSlug, DEPLOY_KEY);
      const { opened: extraConns, rejected: extraRejected } = await openConnections(
        env.wsUrl,
        extraSlug,
        1,
        30_000,
      );
      allConnections.push(...extraConns);

      console.log(`Extra agent: ${extraConns.length} connected, ${extraRejected} rejected`);

      // The extra agent should have connected (LRU eviction freed a slot)
      expect(extraConns.length).toBe(1);

      // Server should still be healthy
      const healthy = await checkHealth(env.serverUrl);
      expect(healthy).toBe(true);

      // Memory should be safe
      const mem = sampleMemory(env.containerId);
      console.log(`Final memory: ${mem.percent.toFixed(1)}%`);
      expect(mem.percent).toBeLessThan(90);
    } finally {
      await closeAll(allConnections);
    }
  });
});
