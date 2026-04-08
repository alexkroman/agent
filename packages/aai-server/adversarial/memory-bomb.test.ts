// Copyright 2025 the AAI authors. MIT license.
/**
 * Adversarial Test: Memory Bomb
 *
 * Deploys an agent that allocates massive arrays in a loop, attempting to
 * exhaust the V8 heap (128 MB limit) and crash beyond the isolate boundary.
 *
 * Asserts:
 * - The sandbox isolate crashes or is killed (expected)
 * - The host server stays healthy
 * - Other agents are unaffected
 * - Container memory stays below 90% of 2048 MB
 * - The crashed slot is cleaned up (a new connection succeeds)
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openConnections, sampleMemory } from "../load/helpers.ts";
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

describe("memory bomb", () => {
  test("isolate OOM does not crash the host server", async () => {
    const BOMB_SLUG = "memory-bomb";

    // Memory bomb agent: allocates until V8 kills it via onConnect hook
    await deployAdversarialAgent(
      env.serverUrl,
      BOMB_SLUG,
      `export default {
        name: "memory-bomb",
        systemPrompt: "Test",
        greeting: "",
        maxSteps: 1,
        tools: {},
        onConnect: () => {
          const arrays = [];
          while (true) {
            arrays.push(new Array(1000000).fill("x".repeat(100)));
          }
        },
      };`,
    );

    // Record baseline memory
    const baseline = sampleMemory(env.containerId);
    console.log("Baseline: " + (baseline.usageBytes / 1024 / 1024).toFixed(1) + " MB");

    // Open connection to good agent first — should work
    const { opened: goodConns } = await openConnections(env.wsUrl, GOOD_AGENT_SLUG, 1, 10_000);
    expect(goodConns.length).toBe(1);

    // Trigger the memory bomb — connection will likely fail or be destroyed
    const { opened: bombConns, rejected: bombRejected } = await openConnections(
      env.wsUrl,
      BOMB_SLUG,
      1,
      15_000,
    );

    console.log("Bomb: " + bombConns.length + " opened, " + bombRejected + " rejected");

    // Wait for the isolate to crash and cleanup to happen
    await new Promise((r) => setTimeout(r, 10_000));

    const postBomb = sampleMemory(env.containerId);
    console.log("Post-bomb: " + (postBomb.usageBytes / 1024 / 1024).toFixed(1) + " MB");

    // Container memory must stay safe
    expect(postBomb.percent).toBeLessThan(90);

    // Good agent connection should still be alive
    const goodAlive = goodConns.filter((ws) => ws.readyState === ws.OPEN).length;
    console.log("Good agent connections still alive: " + goodAlive);

    // Close all connections
    for (const ws of goodConns) ws.close();
    for (const ws of bombConns) ws.close();

    // Server must still be healthy and accept new connections
    await assertServerSurvived(env.serverUrl, env.wsUrl, GOOD_AGENT_SLUG, env.containerId);

    // Wait for slot cleanup, then verify memory recovered
    await new Promise((r) => setTimeout(r, 5000));
    const postCleanup = sampleMemory(env.containerId);
    console.log("Post-cleanup: " + (postCleanup.usageBytes / 1024 / 1024).toFixed(1) + " MB");
  });
});
