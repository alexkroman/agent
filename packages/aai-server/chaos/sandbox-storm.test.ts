// Copyright 2025 the AAI authors. MIT license.
/**
 * Chaos Test 2: Concurrent Sandbox Spawn Storm
 *
 * Deploys many agents with different slugs and opens connections to each.
 * Verifies the server caps sandbox spawns with back-pressure (503/destroy)
 * and existing sessions continue working.
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

describe("sandbox spawn storm", () => {
  test("server caps slot count and rejects excess spawns", async () => {
    const MAX_AGENTS = 8; // MAX_SLOTS is 5 in chaos defaults
    const allConnections: import("ws").default[] = [];
    const deployedSlugs: string[] = [];
    let rejectedCount = 0;

    try {
      // Deploy agents
      for (let i = 0; i < MAX_AGENTS; i++) {
        const slug = `storm-agent-${i}`;
        try {
          await deployTestAgent(env.serverUrl, slug, DEPLOY_KEY);
          deployedSlugs.push(slug);
        } catch {
          // Deploy might fail if server is under pressure — that's ok
        }
      }

      // Open one connection to each agent (triggers sandbox spawn)
      for (const slug of deployedSlugs) {
        const { opened, rejected } = await openConnections(env.wsUrl, slug, 1, 15_000);
        allConnections.push(...opened);
        rejectedCount += rejected;

        const mem = sampleMemory(env.containerId);
        console.log(
          `Agent ${slug}: ${opened.length > 0 ? "connected" : "rejected"}, ` +
            `memory ${mem.percent.toFixed(1)}%`,
        );

        // Fail early on dangerous memory usage
        expect(mem.percent).toBeLessThan(90);
      }

      // Some connections should have been rejected (MAX_SLOTS=5)
      expect(rejectedCount).toBeGreaterThan(0);

      // Health should still be responsive
      const healthy = await checkHealth(env.serverUrl);
      expect(healthy).toBe(true);

      // At least some connections should be working
      const aliveCount = allConnections.filter((ws) => ws.readyState === ws.OPEN).length;
      expect(aliveCount).toBeGreaterThan(0);
      expect(aliveCount).toBeLessThanOrEqual(5); // MAX_SLOTS

      console.log(`Result: ${aliveCount} active, ${rejectedCount} rejected`);
    } finally {
      await closeAll(allConnections);
    }
  });
});
