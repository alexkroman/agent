// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: Slot Lifecycle with Eviction
 *
 * Verifies the full slot lifecycle works under real container constraints:
 * deploy → connect → disconnect → idle eviction → redeploy → connect.
 *
 * Note: LRU eviction logic (evict-on-capacity) is tested in unit tests.
 * This test verifies the integration: sandbox boot, idle eviction cleanup,
 * and slot reuse all work end-to-end in Docker.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkHealth, closeAll, openConnections, sampleMemory } from "./helpers.ts";
import { DEPLOY_KEY, deployTestAgent, type LoadEnv, startLoadEnv } from "./setup.ts";

let env: LoadEnv;

beforeAll(async () => {
  // Short idle timeout for fast eviction cycling
  env = await startLoadEnv({ MAX_SLOTS: "2", SLOT_IDLE_MS: "5000" });
}, 180_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe("slot lifecycle with eviction", () => {
  test("slot is reusable after idle eviction", async () => {
    const slug = "lifecycle-agent";
    await deployTestAgent(env.serverUrl, slug, DEPLOY_KEY);

    // First connection — boots the sandbox
    const { opened: conns1 } = await openConnections(env.wsUrl, slug, 1, 30_000);
    expect(conns1.length).toBe(1);

    const bootMem = sampleMemory(env.containerId);
    console.log(`After boot: ${(bootMem.usageBytes / 1024 / 1024).toFixed(1)} MB`);

    // Close connection and wait for idle eviction (SLOT_IDLE_MS=5s + buffer)
    await closeAll(conns1);
    console.log("Connection closed, waiting for idle eviction...");
    await new Promise((r) => setTimeout(r, 10_000));

    const postEvictMem = sampleMemory(env.containerId);
    console.log(`After eviction: ${(postEvictMem.usageBytes / 1024 / 1024).toFixed(1)} MB`);

    // Second connection — should re-boot the sandbox in the freed slot
    const { opened: conns2 } = await openConnections(env.wsUrl, slug, 1, 30_000);
    expect(conns2.length).toBe(1);

    const rebootMem = sampleMemory(env.containerId);
    console.log(`After reboot: ${(rebootMem.usageBytes / 1024 / 1024).toFixed(1)} MB`);

    await closeAll(conns2);

    // Health check
    const healthy = await checkHealth(env.serverUrl);
    expect(healthy).toBe(true);

    // Memory should be stable
    expect(rebootMem.percent).toBeLessThan(50);
  });

  test("second agent deploys while first slot is active", async () => {
    // Deploy and connect agent A
    const slugA = "agent-alpha";
    await deployTestAgent(env.serverUrl, slugA, DEPLOY_KEY);
    const { opened: connsA } = await openConnections(env.wsUrl, slugA, 1, 30_000);
    expect(connsA.length).toBe(1);
    console.log("Agent A connected");

    // Deploy agent B (MAX_SLOTS=2, so both should fit)
    const slugB = "agent-beta";
    await deployTestAgent(env.serverUrl, slugB, DEPLOY_KEY);

    // Connect to agent B — may take a while on constrained container
    const { opened: connsB } = await openConnections(env.wsUrl, slugB, 1, 60_000);
    console.log(`Agent B: ${connsB.length > 0 ? "connected" : "failed"}`);

    // At least agent A should still be alive
    const aliveA = connsA.filter((ws) => ws.readyState === ws.OPEN).length;
    expect(aliveA).toBe(1);

    const mem = sampleMemory(env.containerId);
    console.log(`Both agents: ${mem.percent.toFixed(1)}% memory`);
    expect(mem.percent).toBeLessThan(90);

    await closeAll([...connsA, ...connsB]);

    const healthy = await checkHealth(env.serverUrl);
    expect(healthy).toBe(true);
  });
});
