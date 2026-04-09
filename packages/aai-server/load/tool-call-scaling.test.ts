// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: Tool Call Latency vs Isolate Count
 *
 * Boots increasing numbers of unique tool-calling agents in real
 * secure-exec isolates and measures per-call latency at each tier.
 * No Docker or S2S required — runs directly against the isolate pool.
 *
 * Run: pnpm vitest run --config packages/aai-server/load/vitest.load.config.ts tool-call-scaling
 */

import { afterAll, describe, expect, test } from "vitest";
import { _internals } from "../sandbox.ts";
import { createMockKv } from "../test-utils.ts";

// ── Agent bundle with a tool that does real work ────────────────────────

function makeAgentBundle(id: number): string {
  return `
export default {
  name: "load-agent-${id}",
  systemPrompt: "Load test agent",
  greeting: "",
  maxSteps: 1,
  tools: {
    compute: {
      description: "Do a small computation",
      execute(args) {
        const data = Array.from({ length: 100 }, (_, i) => ({ id: i, value: "item-" + i }));
        const filtered = data.filter(d => d.id % 2 === 0);
        return JSON.stringify({ count: filtered.length, agent: ${id} });
      },
    },
  },
};
`;
}

// ── Stats helpers ───────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function stats(latencies: number[]) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
    avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
  };
}

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

// ── Test ────────────────────────────────────────────────────────────────

type Isolate = {
  id: number;
  channel: Awaited<ReturnType<typeof _internals.startIsolate>>["channel"];
  terminate: () => Promise<void>;
};

const allIsolates: Isolate[] = [];

afterAll(async () => {
  for (const iso of allIsolates) {
    iso.channel.shutdown();
    await iso.terminate().catch(() => {
      /* noop */
    });
  }
});

describe("tool call latency scaling", () => {
  const TIERS = [1, 2, 5, 10, 15, 20];
  const CALLS_PER_AGENT = 5;
  const TOOL_TIMEOUT_MS = 10_000;

  test("latency vs isolate count", async () => {
    const results: {
      agents: number;
      rssMb: number;
      latency: ReturnType<typeof stats>;
      totalMs: number;
      failures: number;
      totalCalls: number;
    }[] = [];

    let hitCeiling = false;

    for (const tier of TIERS) {
      if (hitCeiling) break;

      // Boot isolates up to this tier
      let bootFailed = false;
      while (allIsolates.length < tier) {
        const id = allIsolates.length;
        try {
          const kv = createMockKv();
          const isolate = await _internals.startIsolate(makeAgentBundle(id), kv, {});

          await isolate.channel.call(
            { type: "hook", hook: "onConnect", sessionId: `s-${id}` },
            TOOL_TIMEOUT_MS,
          );

          allIsolates.push({
            id,
            channel: isolate.channel,
            terminate: () => isolate.runtime.terminate(),
          });
        } catch (err) {
          console.log(`Boot failed at isolate ${id}: ${err}`);
          bootFailed = true;
          break;
        }
      }

      if (bootFailed) {
        console.log(`Ceiling hit: could not boot isolate ${allIsolates.length + 1}`);
        hitCeiling = true;
        break;
      }

      // Measure RSS after booting
      if (global.gc) global.gc();
      const rss = rssMb();

      // Fire tool calls across all agents concurrently
      const latencies: number[] = [];
      let failures = 0;
      const tierStart = performance.now();

      for (let round = 0; round < CALLS_PER_AGENT; round++) {
        const roundResults = await Promise.allSettled(
          allIsolates.slice(0, tier).map(async (iso) => {
            const t0 = performance.now();
            const result = await iso.channel.call<{ result: string }>(
              {
                type: "tool",
                name: "compute",
                sessionId: `s-${iso.id}`,
                args: {},
                messages: [],
              },
              TOOL_TIMEOUT_MS,
            );
            const elapsed = performance.now() - t0;

            const parsed = JSON.parse(result.result);
            expect(parsed.count).toBe(50);

            return elapsed;
          }),
        );

        for (const r of roundResults) {
          if (r.status === "fulfilled") {
            latencies.push(r.value);
          } else {
            failures++;
          }
        }
      }

      const totalMs = performance.now() - tierStart;
      const totalCalls = tier * CALLS_PER_AGENT;

      if (latencies.length === 0) {
        console.log(`${String(tier).padStart(3)} agents | ALL CALLS FAILED (${failures} failures)`);
        hitCeiling = true;
        break;
      }

      const s = stats(latencies);
      results.push({ agents: tier, rssMb: rss, latency: s, totalMs, failures, totalCalls });

      console.log(
        `${String(tier).padStart(3)} agents | ` +
          `RSS ${rss.toFixed(0).padStart(5)}MB | ` +
          `p50 ${s.p50.toFixed(1).padStart(6)}ms | ` +
          `p95 ${s.p95.toFixed(1).padStart(6)}ms | ` +
          `p99 ${s.p99.toFixed(1).padStart(6)}ms | ` +
          `max ${s.max.toFixed(1).padStart(6)}ms | ` +
          `${failures > 0 ? `FAIL ${failures}/${totalCalls}` : `ok ${totalCalls} calls`} | ` +
          `${totalMs.toFixed(0)}ms`,
      );

      // If more than 20% of calls fail, we've hit the ceiling
      if (failures / totalCalls > 0.2) {
        console.log(
          `Ceiling hit: ${((failures / totalCalls) * 100).toFixed(0)}% failure rate at ${tier} agents`,
        );
        hitCeiling = true;
      }
    }

    // Print summary table
    console.log("\n--- Summary ---");
    console.log(
      "Agents".padStart(6),
      "RSS(MB)".padStart(8),
      "p50(ms)".padStart(8),
      "p95(ms)".padStart(8),
      "p99(ms)".padStart(8),
      "max(ms)".padStart(8),
      "calls/s".padStart(8),
      "fail%".padStart(6),
    );
    console.log("-".repeat(64));
    for (const r of results) {
      const callsPerSec = (r.totalCalls - r.failures) / (r.totalMs / 1000);
      console.log(
        String(r.agents).padStart(6),
        r.rssMb.toFixed(0).padStart(8),
        r.latency.p50.toFixed(1).padStart(8),
        r.latency.p95.toFixed(1).padStart(8),
        r.latency.p99.toFixed(1).padStart(8),
        r.latency.max.toFixed(1).padStart(8),
        callsPerSec.toFixed(1).padStart(8),
        `${((r.failures / r.totalCalls) * 100).toFixed(0).padStart(5)}%`,
      );
    }

    const maxTier = results.at(-1);
    if (maxTier) {
      console.log("-".repeat(64));
      console.log(
        `Peak: ${maxTier.agents} agents, ${maxTier.rssMb.toFixed(0)}MB RSS, ` +
          `p50=${maxTier.latency.p50.toFixed(1)}ms`,
      );
    }

    // At least 1 agent should work
    expect(results.length).toBeGreaterThan(0);
    // First tier should have zero failures
    expect(results[0]?.failures).toBe(0);
  }, 180_000);
});
