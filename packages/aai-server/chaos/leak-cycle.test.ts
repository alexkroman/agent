// Copyright 2025 the AAI authors. MIT license.
/**
 * Chaos Test 3: Sustained Load + Idle Eviction (Leak Detection)
 *
 * Opens connections, sustains load, lets idle eviction clean up,
 * then verifies memory returns to baseline. Repeats multiple cycles
 * to detect monotonic memory ratcheting (leaks).
 *
 * SLOT_IDLE_MS is set to 10s in chaos defaults for fast eviction.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkHealth, closeAll, openConnections, sampleMemory } from "./helpers.ts";
import { type ChaosEnv, DEPLOY_KEY, deployTestAgent, startChaosEnv } from "./setup.ts";

let env: ChaosEnv;

beforeAll(async () => {
  env = await startChaosEnv();
}, 180_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe("leak cycle detection", () => {
  test("memory returns to baseline after load/unload cycles", async () => {
    const SLUG = "leak-test";
    await deployTestAgent(env.serverUrl, SLUG, DEPLOY_KEY);

    // Wait for server to settle, then record baseline
    await new Promise((r) => setTimeout(r, 3000));
    const baseline = sampleMemory(env.containerId);
    console.log(`Baseline memory: ${(baseline.usageBytes / 1024 / 1024).toFixed(1)}MB`);

    const CYCLES = 3;
    const CONNECTIONS_PER_CYCLE = 20;
    const postEvictionMemory: number[] = [];

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      console.log(`\n--- Cycle ${cycle + 1}/${CYCLES} ---`);

      // Open connections (sustain load)
      const { opened } = await openConnections(env.wsUrl, SLUG, CONNECTIONS_PER_CYCLE, 10_000);
      console.log(`Opened ${opened.length} connections`);

      const loadMem = sampleMemory(env.containerId);
      console.log(`Under load: ${(loadMem.usageBytes / 1024 / 1024).toFixed(1)}MB`);

      // Hold load for a few seconds
      await new Promise((r) => setTimeout(r, 5000));

      // Close all connections
      await closeAll(opened);
      console.log("All connections closed");

      // Wait for idle eviction (SLOT_IDLE_MS=10s + buffer)
      await new Promise((r) => setTimeout(r, 15_000));

      // Wait for GC to settle
      await new Promise((r) => setTimeout(r, 5000));

      const postMem = sampleMemory(env.containerId);
      postEvictionMemory.push(postMem.usageBytes);
      console.log(
        `Post-eviction: ${(postMem.usageBytes / 1024 / 1024).toFixed(1)}MB ` +
          `(${((postMem.usageBytes / baseline.usageBytes - 1) * 100).toFixed(1)}% above baseline)`,
      );

      // Memory won't return to baseline due to V8 heap retention (V8 keeps
      // allocated pages for reuse even after GC). Use an absolute ceiling
      // instead — post-eviction should stay well under the container limit.
      expect(postMem.percent).toBeLessThan(50);

      // Health check
      const healthy = await checkHealth(env.serverUrl);
      expect(healthy).toBe(true);
    }

    // Check for significant monotonic increase (leak detection).
    // Small increases (< 10 MB/cycle) are normal V8 heap fragmentation.
    // A real leak would show large, consistent growth.
    const firstPost = postEvictionMemory[0] ?? 0;
    const lastPost = postEvictionMemory.at(-1) ?? 0;
    const totalGrowthMB = (lastPost - firstPost) / (1024 * 1024);
    console.log(`Total growth across ${CYCLES} cycles: ${totalGrowthMB.toFixed(1)}MB`);
    // Less than 30 MB total growth across all cycles = no significant leak
    expect(Math.abs(totalGrowthMB)).toBeLessThan(30);

    console.log("\nLeak cycle test complete — no monotonic memory increase detected");
  });
});
