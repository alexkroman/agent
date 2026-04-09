// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: Multiple Sessions on a Single Isolate
 *
 * Boots one agent isolate and connects increasing numbers of concurrent
 * sessions, firing tool calls from each. Measures how session count
 * affects per-call latency within a single isolate.
 *
 * Run: pnpm vitest run --config packages/aai-server/load/vitest.load.config.ts session-scaling
 */

import { afterAll, describe, expect, test } from "vitest";
import { _internals } from "../sandbox.ts";
import { createMockKv } from "../test-utils.ts";

// ── Agent bundle with state to verify session isolation ─────────────────

const AGENT_BUNDLE = `
export default {
  name: "session-scale-agent",
  systemPrompt: "Session scaling test",
  greeting: "",
  maxSteps: 1,
  state: () => ({ callCount: 0 }),
  tools: {
    track: {
      description: "Increment call count and return it",
      execute(args, ctx) {
        ctx.state.callCount++;
        return JSON.stringify({
          sessionId: ctx.sessionId,
          callCount: ctx.state.callCount,
        });
      },
    },
    compute: {
      description: "Do a small computation",
      execute(args) {
        const data = Array.from({ length: 100 }, (_, i) => ({ id: i, value: "item-" + i }));
        const filtered = data.filter(d => d.id % 2 === 0);
        return JSON.stringify({ count: filtered.length });
      },
    },
  },
};
`;

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

describe("session scaling on single isolate", () => {
  let channel: Awaited<ReturnType<typeof _internals.startIsolate>>["channel"];
  let cleanup: () => Promise<void>;

  const TIERS = [1, 5, 10, 25, 50, 100];
  const CALLS_PER_SESSION = 3;
  const TOOL_TIMEOUT_MS = 10_000;

  afterAll(async () => {
    await cleanup?.();
  });

  test("latency vs session count", async () => {
    // Boot single isolate
    const kv = createMockKv();
    const t0 = performance.now();
    const isolate = await _internals.startIsolate(AGENT_BUNDLE, kv, {});
    const bootMs = performance.now() - t0;
    channel = isolate.channel;
    cleanup = async () => {
      channel.shutdown();
      await isolate.runtime.terminate();
    };

    const baseRss = rssMb();
    console.log(
      `Isolate booted in ${bootMs.toFixed(1)}ms, baseline RSS: ${baseRss.toFixed(0)}MB\n`,
    );

    const results: {
      sessions: number;
      rssMb: number;
      latency: ReturnType<typeof stats>;
      totalMs: number;
      failures: number;
      totalCalls: number;
    }[] = [];

    const connectedSessions = new Set<string>();

    for (const tier of TIERS) {
      // Connect sessions up to this tier
      while (connectedSessions.size < tier) {
        const sid = `sess-${connectedSessions.size}`;
        await channel.call({ type: "hook", hook: "onConnect", sessionId: sid }, TOOL_TIMEOUT_MS);
        connectedSessions.add(sid);
      }

      if (global.gc) global.gc();
      const rss = rssMb();

      // Fire tool calls from all sessions concurrently
      const latencies: number[] = [];
      let failures = 0;
      const tierStart = performance.now();
      const sessionIds = [...connectedSessions].slice(0, tier);

      for (let round = 0; round < CALLS_PER_SESSION; round++) {
        const roundResults = await Promise.allSettled(
          sessionIds.map(async (sid) => {
            const t0 = performance.now();
            await channel.call<{ result: string }>(
              {
                type: "tool",
                name: "compute",
                sessionId: sid,
                args: {},
                messages: [],
              },
              TOOL_TIMEOUT_MS,
            );
            return performance.now() - t0;
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
      const totalCalls = tier * CALLS_PER_SESSION;

      if (latencies.length === 0) {
        console.log(`${String(tier).padStart(5)} sessions | ALL CALLS FAILED`);
        break;
      }

      const s = stats(latencies);
      results.push({ sessions: tier, rssMb: rss, latency: s, totalMs, failures, totalCalls });

      console.log(
        `${String(tier).padStart(5)} sessions | ` +
          `RSS ${rss.toFixed(0).padStart(5)}MB | ` +
          `p50 ${s.p50.toFixed(1).padStart(6)}ms | ` +
          `p95 ${s.p95.toFixed(1).padStart(6)}ms | ` +
          `p99 ${s.p99.toFixed(1).padStart(6)}ms | ` +
          `max ${s.max.toFixed(1).padStart(6)}ms | ` +
          `${failures > 0 ? `FAIL ${failures}/${totalCalls}` : `ok ${totalCalls} calls`} | ` +
          `${totalMs.toFixed(0)}ms`,
      );
    }

    // Verify session state isolation — each session should have independent state
    console.log("\nVerifying session state isolation...");
    const s0 = await channel.call<{ result: string }>(
      { type: "tool", name: "track", sessionId: "sess-0", args: {}, messages: [] },
      TOOL_TIMEOUT_MS,
    );
    const s1 = await channel.call<{ result: string }>(
      { type: "tool", name: "track", sessionId: "sess-1", args: {}, messages: [] },
      TOOL_TIMEOUT_MS,
    );
    const r0 = JSON.parse(s0.result);
    const r1 = JSON.parse(s1.result);
    expect(r0.sessionId).toBe("sess-0");
    expect(r1.sessionId).toBe("sess-1");
    // Each session's state is independent
    expect(r0.callCount).toBe(r1.callCount);
    console.log(`Session isolation OK: sess-0 count=${r0.callCount}, sess-1 count=${r1.callCount}`);

    // Print summary table
    console.log("\n--- Summary ---");
    console.log(
      "Sessions".padStart(8),
      "RSS(MB)".padStart(8),
      "p50(ms)".padStart(8),
      "p95(ms)".padStart(8),
      "p99(ms)".padStart(8),
      "max(ms)".padStart(8),
      "calls/s".padStart(8),
      "fail%".padStart(6),
    );
    console.log("-".repeat(66));
    for (const r of results) {
      const callsPerSec = (r.totalCalls - r.failures) / (r.totalMs / 1000);
      console.log(
        String(r.sessions).padStart(8),
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
      const rssDelta = maxTier.rssMb - baseRss;
      console.log("-".repeat(66));
      console.log(
        `Peak: ${maxTier.sessions} sessions, ` +
          `RSS +${rssDelta.toFixed(0)}MB from baseline, ` +
          `p50=${maxTier.latency.p50.toFixed(1)}ms`,
      );
    }

    // Assertions
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.failures).toBe(0);
  }, 120_000);
});
