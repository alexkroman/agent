// Copyright 2025 the AAI authors. MIT license.
/**
 * Chaos Test 1: WebSocket Connection Flood
 *
 * Verifies the server rejects connections before OOM.
 * Opens connections in batches, monitors memory, asserts the server
 * stays healthy and rejects excess connections gracefully.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkHealth, closeAll, openConnections, sampleMemory } from "./helpers.ts";
import { type ChaosEnv, DEPLOY_KEY, deployTestAgent, startChaosEnv } from "./setup.ts";

let env: ChaosEnv;
const SLUG = "flood-test";

beforeAll(async () => {
  env = await startChaosEnv();
  await deployTestAgent(env.serverUrl, SLUG, DEPLOY_KEY);
}, 180_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe("connection flood", () => {
  test("server rejects connections before OOM and stays healthy", async () => {
    const allConnections: import("ws").default[] = [];
    const BATCH_SIZE = 10;
    const MAX_BATCHES = 10; // Up to 100 connections (MAX_CONNECTIONS is 50 in chaos defaults)
    let rejectedTotal = 0;

    try {
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const { opened, rejected } = await openConnections(env.wsUrl, SLUG, BATCH_SIZE);
        allConnections.push(...opened);
        rejectedTotal += rejected;

        // Check memory isn't approaching limit
        const mem = sampleMemory(env.containerId);
        console.log(
          `Batch ${batch + 1}: ${allConnections.length} open, ${rejectedTotal} rejected, ` +
            `memory ${mem.percent.toFixed(1)}%`,
        );

        // If we're seeing rejections, the limit is working
        if (rejected > 0) break;

        // Fail early if memory is dangerously high
        expect(mem.percent).toBeLessThan(90);
      }

      // We should have seen some rejections (MAX_CONNECTIONS=50 in chaos defaults)
      expect(rejectedTotal).toBeGreaterThan(0);

      // Health endpoint should still respond
      const healthy = await checkHealth(env.serverUrl);
      expect(healthy).toBe(true);

      // Existing connections should still be alive
      const aliveCount = allConnections.filter((ws) => ws.readyState === ws.OPEN).length;
      expect(aliveCount).toBeGreaterThan(0);

      // Memory should have stabilized (not still growing)
      const mem1 = sampleMemory(env.containerId);
      await new Promise((r) => setTimeout(r, 2000));
      const mem2 = sampleMemory(env.containerId);
      const growth = mem2.usageBytes - mem1.usageBytes;
      const growthMB = growth / (1024 * 1024);
      console.log(`Memory growth after stabilization: ${growthMB.toFixed(1)}MB`);
      expect(growthMB).toBeLessThan(20); // Less than 20MB growth = stabilized
    } finally {
      await closeAll(allConnections);
    }
  });
});
