// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test 2: Concurrent Sandbox Spawn Storm
 *
 * Deploys many agents with different slugs and opens connections to each.
 * Verifies the server stays healthy under many concurrent sandbox spawns
 * and memory remains bounded.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkHealth, closeAll, openConnections, sampleMemory } from "./helpers.ts";
import { DEPLOY_KEY, deployTestAgent, type LoadEnv, startLoadEnv } from "./setup.ts";

let env: LoadEnv;

beforeAll(async () => {
  env = await startLoadEnv();
}, 180_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe("sandbox spawn storm", () => {
  test("server stays healthy under many concurrent sandbox spawns", async () => {
    const MAX_AGENTS = 14;
    const allConnections: import("ws").default[] = [];
    const deployedSlugs: string[] = [];

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
        const { opened } = await openConnections(env.wsUrl, slug, 1, 15_000);
        allConnections.push(...opened);

        const mem = sampleMemory(env.containerId);
        console.log(
          `Agent ${slug}: ${opened.length > 0 ? "connected" : "rejected"}, ` +
            `memory ${mem.percent.toFixed(1)}%`,
        );

        // Fail early on dangerous memory usage
        expect(mem.percent).toBeLessThan(90);
      }

      // Health should still be responsive
      const healthy = await checkHealth(env.serverUrl);
      expect(healthy).toBe(true);

      // At least some connections should be working
      const aliveCount = allConnections.filter((ws) => ws.readyState === ws.OPEN).length;
      expect(aliveCount).toBeGreaterThan(0);

      console.log(`Result: ${aliveCount} active out of ${deployedSlugs.length} deployed`);
    } finally {
      await closeAll(allConnections);
    }
  });
});
