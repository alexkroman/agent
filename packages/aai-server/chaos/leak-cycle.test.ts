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

      // Memory should be within 20% of baseline after eviction
      expect(postMem.usageBytes).toBeLessThan(baseline.usageBytes * 1.2);

      // Health check
      const healthy = await checkHealth(env.serverUrl);
      expect(healthy).toBe(true);
    }

    // Check for monotonic increase (leak detection)
    // Each post-eviction sample should not be consistently higher than the previous
    let increasing = 0;
    for (let i = 1; i < postEvictionMemory.length; i++) {
      const cur = postEvictionMemory[i] ?? 0;
      const prev = postEvictionMemory[i - 1] ?? 0;
      if (cur > prev) {
        increasing++;
      }
    }
    // If ALL cycles show increasing memory, likely a leak
    expect(increasing).toBeLessThan(CYCLES - 1);

    console.log("\nLeak cycle test complete — no monotonic memory increase detected");
  });
});
