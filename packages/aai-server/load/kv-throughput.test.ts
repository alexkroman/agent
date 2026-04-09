// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: KV Throughput Under Contention
 *
 * Boots a single isolate with KV tools, connects 10 sessions, then fires
 * concurrent KV operations at scaling tiers. Measures latency and throughput
 * for read and write operations under contention.
 *
 * Run: pnpm vitest run --config packages/aai-server/load/vitest.load.config.ts kv-throughput
 */

import { afterAll, describe, expect, test } from "vitest";
import { _internals } from "../sandbox.ts";
import { createMockKv } from "../test-utils.ts";

// ── Agent bundle with KV tools ───────────────────────────────────────────

const AGENT_BUNDLE = `
export default {
  name: "kv-stress-agent",
  systemPrompt: "KV stress test",
  greeting: "",
  maxSteps: 1,
  tools: {
    kv_write: {
      description: "Write to KV",
      async execute(args, ctx) {
        await ctx.kv.set("key-" + args.key, { value: args.value, ts: Date.now() });
        return "ok";
      },
    },
    kv_read: {
      description: "Read from KV",
      async execute(args, ctx) {
        const val = await ctx.kv.get("key-" + args.key);
        return JSON.stringify(val);
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

describe("KV throughput under contention", () => {
  let channel: Awaited<ReturnType<typeof _internals.startIsolate>>["channel"];
  let cleanup: () => Promise<void>;

  const SESSION_COUNT = 10;
  const TIERS = [1, 5, 10, 25, 50, 100];
  const TOOL_TIMEOUT_MS = 10_000;

  afterAll(async () => {
    await cleanup?.();
  });

  test("KV ops latency and throughput at scale", async () => {
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
    console.log(`Isolate booted in ${bootMs.toFixed(1)}ms, baseline RSS: ${baseRss.toFixed(0)}MB`);

    // Connect sessions
    for (let i = 0; i < SESSION_COUNT; i++) {
      await channel.call(
        { type: "hook", hook: "onConnect", sessionId: `kv-sess-${i}` },
        TOOL_TIMEOUT_MS,
      );
    }
    console.log(`Connected ${SESSION_COUNT} sessions\n`);

    const results: {
      concurrency: number;
      rssMb: number;
      writeLatency: ReturnType<typeof stats>;
      readLatency: ReturnType<typeof stats>;
      totalMs: number;
      failures: number;
      totalOps: number;
    }[] = [];

    for (const tier of TIERS) {
      if (global.gc) global.gc();
      const rss = rssMb();

      const writeLatencies: number[] = [];
      const readLatencies: number[] = [];
      let failures = 0;
      const tierStart = performance.now();

      // Fire N write ops + N read ops concurrently
      const writePromises = Array.from({ length: tier }, (_, i) => {
        const sessionId = `kv-sess-${i % SESSION_COUNT}`;
        const t0 = performance.now();
        return channel
          .call<{ result: string }>(
            {
              type: "tool",
              name: "kv_write",
              sessionId,
              args: { key: `t${tier}-${i}`, value: `val-${i}` },
              messages: [],
            },
            TOOL_TIMEOUT_MS,
          )
          .then(() => {
            writeLatencies.push(performance.now() - t0);
          })
          .catch(() => {
            failures++;
          });
      });

      const readPromises = Array.from({ length: tier }, (_, i) => {
        const sessionId = `kv-sess-${i % SESSION_COUNT}`;
        const t0 = performance.now();
        return channel
          .call<{ result: string }>(
            {
              type: "tool",
              name: "kv_read",
              sessionId,
              args: { key: `t${tier}-${i}` },
              messages: [],
            },
            TOOL_TIMEOUT_MS,
          )
          .then(() => {
            readLatencies.push(performance.now() - t0);
          })
          .catch(() => {
            failures++;
          });
      });

      await Promise.all([...writePromises, ...readPromises]);

      const totalMs = performance.now() - tierStart;
      const totalOps = tier * 2; // writes + reads

      if (writeLatencies.length === 0 && readLatencies.length === 0) {
        console.log(
          `${String(tier).padStart(5)} concurrent | ALL OPS FAILED (${failures} failures)`,
        );
        break;
      }

      const ws = writeLatencies.length > 0 ? stats(writeLatencies) : stats([0]);
      const rs = readLatencies.length > 0 ? stats(readLatencies) : stats([0]);
      results.push({
        concurrency: tier,
        rssMb: rss,
        writeLatency: ws,
        readLatency: rs,
        totalMs,
        failures,
        totalOps,
      });

      console.log(
        `${String(tier).padStart(5)} concurrent | ` +
          `RSS ${rss.toFixed(0).padStart(5)}MB | ` +
          `write p50 ${ws.p50.toFixed(1).padStart(6)}ms p95 ${ws.p95.toFixed(1).padStart(6)}ms | ` +
          `read p50 ${rs.p50.toFixed(1).padStart(6)}ms p95 ${rs.p95.toFixed(1).padStart(6)}ms | ` +
          `${failures > 0 ? `FAIL ${failures}/${totalOps}` : `ok ${totalOps} ops`} | ` +
          `${totalMs.toFixed(0)}ms`,
      );
    }

    // Print summary table
    console.log("\n--- Summary ---");
    console.log(
      "Concurr".padStart(8),
      "RSS(MB)".padStart(8),
      "W-p50".padStart(8),
      "W-p95".padStart(8),
      "R-p50".padStart(8),
      "R-p95".padStart(8),
      "ops/s".padStart(8),
      "fail%".padStart(6),
    );
    console.log("-".repeat(72));
    for (const r of results) {
      const opsPerSec = (r.totalOps - r.failures) / (r.totalMs / 1000);
      console.log(
        String(r.concurrency).padStart(8),
        r.rssMb.toFixed(0).padStart(8),
        r.writeLatency.p50.toFixed(1).padStart(8),
        r.writeLatency.p95.toFixed(1).padStart(8),
        r.readLatency.p50.toFixed(1).padStart(8),
        r.readLatency.p95.toFixed(1).padStart(8),
        opsPerSec.toFixed(1).padStart(8),
        `${((r.failures / r.totalOps) * 100).toFixed(0).padStart(5)}%`,
      );
    }

    const maxTier = results.at(-1);
    if (maxTier) {
      const rssDelta = maxTier.rssMb - baseRss;
      const opsPerSec = (maxTier.totalOps - maxTier.failures) / (maxTier.totalMs / 1000);
      console.log("-".repeat(72));
      console.log(
        `Peak: ${maxTier.concurrency} concurrent ops, ` +
          `RSS +${rssDelta.toFixed(0)}MB from baseline, ` +
          `${opsPerSec.toFixed(1)} ops/s, ` +
          `write p50=${maxTier.writeLatency.p50.toFixed(1)}ms, ` +
          `read p50=${maxTier.readLatency.p50.toFixed(1)}ms`,
      );
    }

    // Loose assertions — primary value is printed stats
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.failures).toBe(0);
  }, 60_000);
});
