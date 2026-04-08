// Copyright 2025 the AAI authors. MIT license.
/**
 * Adversarial Test: CPU Starvation
 *
 * Deploys an agent that enters a tight infinite loop (while true),
 * consuming 100% of one CPU core indefinitely.
 *
 * Asserts:
 * - The host server health endpoint still responds within 5s
 * - Other agents still accept connections and respond
 * - Container memory stays stable (CPU attack should not cause memory growth)
 * - After eviction, the server returns to normal
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkHealth, openConnections, sampleMemory } from "../load/helpers.ts";
import { assertServerSurvived, deployAdversarialAgent, deployGoodAgent } from "./helpers.ts";
import { GOOD_AGENT_SLUG, type LoadEnv, startLoadEnv } from "./setup.ts";

let env: LoadEnv;

beforeAll(async () => {
  env = await startLoadEnv();
  await deployGoodAgent(env.serverUrl, GOOD_AGENT_SLUG);
}, 180_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe("cpu starvation", () => {
  test("tight infinite loop does not starve other agents or the host", async () => {
    const HOG_SLUG = "cpu-hog";

    // CPU hog agent: enters tight infinite loop on connection via onConnect hook
    await deployAdversarialAgent(
      env.serverUrl,
      HOG_SLUG,
      `export default {
        name: "cpu-hog",
        systemPrompt: "Test",
        greeting: "",
        maxSteps: 1,
        tools: {},
        onConnect: () => { while (true) {} },
      };`,
    );

    // Record baseline
    const baseline = sampleMemory(env.containerId);
    console.log(`Baseline: ${(baseline.usageBytes / 1024 / 1024).toFixed(1)} MB`);

    // Open connection to good agent first
    const { opened: goodConns } = await openConnections(env.wsUrl, GOOD_AGENT_SLUG, 1, 10_000);
    expect(goodConns.length).toBe(1);

    // Trigger the CPU hog
    const { opened: hogConns } = await openConnections(env.wsUrl, HOG_SLUG, 1, 15_000);
    console.log(`CPU hog: ${hogConns.length} connections opened`);

    // Wait a few seconds for the hog to be spinning
    await new Promise((r) => setTimeout(r, 5000));

    // Health endpoint must still respond within 5s
    const t0 = Date.now();
    const healthy = await checkHealth(env.serverUrl, 5000);
    const healthLatency = Date.now() - t0;
    console.log(`Health check: ${healthy ? "OK" : "FAILED"} in ${healthLatency}ms`);
    expect(healthy).toBe(true);

    // Good agent must still accept a NEW connection while hog is spinning
    const { opened: newGoodConns, rejected } = await openConnections(
      env.wsUrl,
      GOOD_AGENT_SLUG,
      1,
      10_000,
    );
    console.log(`New good agent conn: ${newGoodConns.length} opened, ${rejected} rejected`);
    expect(newGoodConns.length).toBe(1);

    // Memory should be stable (CPU attack should not grow memory)
    const underLoad = sampleMemory(env.containerId);
    const memGrowthMB = (underLoad.usageBytes - baseline.usageBytes) / (1024 * 1024);
    console.log(`Memory growth under CPU load: ${memGrowthMB.toFixed(1)} MB`);
    expect(underLoad.percent).toBeLessThan(90);

    // Close the hog connections to trigger idle eviction
    for (const ws of hogConns) ws.close();
    for (const ws of goodConns) ws.close();
    for (const ws of newGoodConns) ws.close();

    // Wait for idle eviction (SLOT_IDLE_MS=10s + buffer)
    console.log("Waiting for idle eviction...");
    await new Promise((r) => setTimeout(r, 15_000));

    // Server should be fully recovered
    await assertServerSurvived(env.serverUrl, env.wsUrl, GOOD_AGENT_SLUG, env.containerId);

    const postEviction = sampleMemory(env.containerId);
    console.log(`Post-eviction: ${(postEviction.usageBytes / 1024 / 1024).toFixed(1)} MB`);
  });
});
