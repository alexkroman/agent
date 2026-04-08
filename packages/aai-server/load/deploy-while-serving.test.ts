// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: Redeploy With Active Sessions
 *
 * Tests what happens when an agent is redeployed while it has active
 * tool calls in-flight. Measures latency impact and error behavior
 * during version transitions.
 *
 * Run: pnpm vitest run --config packages/aai-server/load/vitest.load.config.ts deploy-while-serving
 */

import { afterAll, describe, expect, test } from "vitest";
import { _internals } from "../sandbox.ts";
import { createMockKv } from "../test-utils.ts";

// ── Agent bundles ────────────────────────────────────────────────────────

const AGENT_V1 = `
export default {
  name: "deploy-v1",
  systemPrompt: "v1",
  greeting: "",
  maxSteps: 1,
  tools: {
    slow: {
      description: "Slow tool",
      async execute() {
        await new Promise(r => setTimeout(r, 500));
        return "v1-result";
      },
    },
    fast: {
      description: "Fast tool",
      execute() { return "v1-fast"; },
    },
  },
};
`;

const AGENT_V2 = `
export default {
  name: "deploy-v2",
  systemPrompt: "v2",
  greeting: "",
  maxSteps: 1,
  tools: {
    slow: {
      description: "Slow tool",
      async execute() {
        await new Promise(r => setTimeout(r, 100));
        return "v2-result";
      },
    },
    fast: {
      description: "Fast tool",
      execute() { return "v2-fast"; },
    },
  },
};
`;

function makeVersionBundle(version: number): string {
  return `
export default {
  name: "deploy-v${version}",
  systemPrompt: "v${version}",
  greeting: "",
  maxSteps: 1,
  tools: {
    fast: {
      description: "Fast tool",
      execute() { return "v${version}-fast"; },
    },
  },
};
`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

type IsolateHandle = Awaited<ReturnType<typeof _internals.startIsolate>>;

// Track all isolates for cleanup
const pendingCleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const fn of pendingCleanups) {
    await fn().catch(() => {
      /* noop */
    });
  }
});

const TOOL_TIMEOUT_MS = 10_000;

// ── Tests ───────────────────────────────────────────────────────────────

describe("deploy while serving", () => {
  test("scenario 1: in-flight tool survives or errors on shutdown", async () => {
    console.log("--- Scenario 1: In-flight tool behavior during shutdown ---\n");

    const kv = createMockKv();
    const v1 = await _internals.startIsolate(AGENT_V1, kv, {});
    pendingCleanups.push(async () => {
      v1.channel.shutdown();
      await v1.runtime.terminate().catch(() => {
        /* noop */
      });
    });

    // Connect a session
    await v1.channel.call({ type: "hook", hook: "onConnect", sessionId: "s1" }, TOOL_TIMEOUT_MS);

    // Start a slow tool call (500ms) — don't await yet
    const slowCallStart = performance.now();
    const slowCallPromise = v1.channel
      .call<{ result: string }>(
        {
          type: "tool",
          name: "slow",
          sessionId: "s1",
          args: {},
          messages: [],
        },
        TOOL_TIMEOUT_MS,
      )
      .then((r) => ({
        status: "completed" as const,
        result: r.result,
        elapsed: performance.now() - slowCallStart,
      }))
      .catch((err) => ({
        status: "errored" as const,
        error: String(err),
        elapsed: performance.now() - slowCallStart,
      }));

    // Wait a bit to ensure the tool call is in-flight, then terminate v1
    await new Promise((r) => setTimeout(r, 50));

    const terminateStart = performance.now();
    v1.channel.shutdown();
    await v1.runtime.terminate().catch(() => {
      /* intentional noop */
    });
    const terminateMs = performance.now() - terminateStart;

    // See what happened to the in-flight call
    const slowResult = await slowCallPromise;
    const slowMs = slowResult.elapsed;

    console.log(`  Terminate took: ${terminateMs.toFixed(1)}ms`);
    console.log(`  In-flight tool: ${slowResult.status} in ${slowMs.toFixed(1)}ms`);
    if (slowResult.status === "completed") {
      console.log(`  Result: ${slowResult.result}`);
    } else {
      console.log(`  Error: ${slowResult.error}`);
    }

    // Either outcome is acceptable — we just want to document what happens
    expect(["completed", "errored"]).toContain(slowResult.status);
    console.log("");
  }, 30_000);

  test("scenario 2: new version works after redeploy", async () => {
    console.log("--- Scenario 2: New version works after redeploy ---\n");

    // Boot v1 and verify it works
    const kv1 = createMockKv();
    const v1 = await _internals.startIsolate(AGENT_V1, kv1, {});

    const v1Start = performance.now();
    const v1Result = await v1.channel.call<{ result: string }>(
      {
        type: "tool",
        name: "fast",
        sessionId: "s1",
        args: {},
        messages: [],
      },
      TOOL_TIMEOUT_MS,
    );
    const v1Ms = performance.now() - v1Start;
    console.log(`  v1 fast tool: "${v1Result.result}" in ${v1Ms.toFixed(1)}ms`);
    expect(v1Result.result).toBe("v1-fast");

    // Terminate v1 (simulating redeploy)
    v1.channel.shutdown();
    await v1.runtime.terminate().catch(() => {
      /* intentional noop */
    });

    // Boot v2
    const kv2 = createMockKv();
    const v2 = await _internals.startIsolate(AGENT_V2, kv2, {});
    pendingCleanups.push(async () => {
      v2.channel.shutdown();
      await v2.runtime.terminate().catch(() => {
        /* intentional noop */
      });
    });

    const v2Start = performance.now();
    const v2Result = await v2.channel.call<{ result: string }>(
      {
        type: "tool",
        name: "fast",
        sessionId: "s2",
        args: {},
        messages: [],
      },
      TOOL_TIMEOUT_MS,
    );
    const v2Ms = performance.now() - v2Start;
    console.log(`  v2 fast tool: "${v2Result.result}" in ${v2Ms.toFixed(1)}ms`);
    expect(v2Result.result).toBe("v2-fast");

    // Also verify v2's slow tool returns v2 result
    const v2SlowStart = performance.now();
    const v2SlowResult = await v2.channel.call<{ result: string }>(
      {
        type: "tool",
        name: "slow",
        sessionId: "s2",
        args: {},
        messages: [],
      },
      TOOL_TIMEOUT_MS,
    );
    const v2SlowMs = performance.now() - v2SlowStart;
    console.log(`  v2 slow tool: "${v2SlowResult.result}" in ${v2SlowMs.toFixed(1)}ms`);
    expect(v2SlowResult.result).toBe("v2-result");

    console.log("");
  }, 30_000);

  test("scenario 3: rapid redeploy cycle", async () => {
    console.log("--- Scenario 3: Rapid redeploy cycle (5 versions) ---\n");

    const VERSIONS = 5;
    const results: {
      version: number;
      bootMs: number;
      toolMs: number;
      result: string;
      rssMb: number;
    }[] = [];

    let previousHandle: IsolateHandle | null = null;

    for (let v = 1; v <= VERSIONS; v++) {
      // Terminate previous version (simulating redeploy)
      if (previousHandle) {
        previousHandle.channel.shutdown();
        await previousHandle.runtime.terminate().catch(() => {
          /* noop */
        });
        previousHandle = null;
      }

      // Boot new version
      const kv = createMockKv();
      const bootStart = performance.now();
      const handle = await _internals.startIsolate(makeVersionBundle(v), kv, {});
      const bootMs = performance.now() - bootStart;

      // Verify the new version works
      const toolStart = performance.now();
      const result = await handle.channel.call<{ result: string }>(
        {
          type: "tool",
          name: "fast",
          sessionId: `rapid-${v}`,
          args: {},
          messages: [],
        },
        TOOL_TIMEOUT_MS,
      );
      const toolMs = performance.now() - toolStart;

      if (global.gc) global.gc();
      const rss = rssMb();

      results.push({
        version: v,
        bootMs,
        toolMs,
        result: result.result,
        rssMb: rss,
      });

      console.log(
        `  v${v}: boot ${bootMs.toFixed(1).padStart(7)}ms | ` +
          `tool ${toolMs.toFixed(1).padStart(6)}ms | ` +
          `result "${result.result}" | ` +
          `RSS ${rss.toFixed(0)}MB`,
      );

      expect(result.result).toBe(`v${v}-fast`);

      previousHandle = handle;
    }

    // Clean up the last handle
    if (previousHandle) {
      pendingCleanups.push(async () => {
        previousHandle?.channel.shutdown();
        await previousHandle?.runtime.terminate().catch(() => {
          /* noop */
        });
      });
    }

    // Print summary
    console.log("\n--- Rapid Redeploy Summary ---");
    console.log(
      "Version".padStart(8),
      "Boot(ms)".padStart(10),
      "Tool(ms)".padStart(10),
      "RSS(MB)".padStart(8),
      "Result".padStart(12),
    );
    console.log("-".repeat(56));
    for (const r of results) {
      console.log(
        `v${r.version}`.padStart(8),
        r.bootMs.toFixed(1).padStart(10),
        r.toolMs.toFixed(1).padStart(10),
        r.rssMb.toFixed(0).padStart(8),
        r.result.padStart(12),
      );
    }

    const avgBoot = results.reduce((sum, r) => sum + r.bootMs, 0) / results.length;
    const avgTool = results.reduce((sum, r) => sum + r.toolMs, 0) / results.length;
    console.log("-".repeat(56));
    console.log(
      `Avg boot: ${avgBoot.toFixed(1)}ms, avg tool: ${avgTool.toFixed(1)}ms across ${VERSIONS} deploys`,
    );

    // All versions should have produced correct results
    expect(results.length).toBe(VERSIONS);
    for (const r of results) {
      expect(r.result).toBe(`v${r.version}-fast`);
    }
  }, 30_000);
});
