// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: Concurrent Isolate Boot Latency (Cold-Start Storm)
 *
 * Measures what happens when many agents cold-start simultaneously.
 * Boots isolates in growing batches and measures per-isolate boot latency,
 * batch total time, and RSS growth.
 *
 * Note: boots are serialized through the single shared Rust V8 process
 * (~100ms per isolate). "Concurrent" here means overlapping Promise.all
 * requests, not truly parallel V8 session creation.
 *
 * Run: pnpm vitest run --config packages/aai-server/load/vitest.load.config.ts cold-start-storm
 */

import { afterAll, describe, expect, test } from "vitest";
import { _internals } from "../sandbox.ts";
import { createMockKv } from "../test-utils.ts";

// ── Agent bundle factory ─────────────────────────────────────────────────

function makeAgentBundle(id: number): string {
  return `
export default {
  name: "storm-agent-${id}",
  systemPrompt: "Boot storm test",
  greeting: "",
  maxSteps: 1,
  tools: {
    ping: { description: "Ping", execute() { return "pong-${id}"; } },
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
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? 0,
  };
}

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

// ── Test ────────────────────────────────────────────────────────────────

type IsolateHandle = Awaited<ReturnType<typeof _internals.startIsolate>>;

const allIsolates: IsolateHandle[] = [];

afterAll(async () => {
  for (const iso of allIsolates) {
    iso.channel.shutdown();
    await iso.runtime.terminate().catch(() => {
      /* noop */
    });
  }
});

describe("cold-start storm", () => {
  const TIERS = [1, 2, 5, 10, 15, 20];
  const TOOL_TIMEOUT_MS = 10_000;

  test("concurrent boot latency at scale", async () => {
    const baseRss = rssMb();
    console.log(`Baseline RSS: ${baseRss.toFixed(0)}MB\n`);

    const results: {
      concurrency: number;
      rssMb: number;
      batchMs: number;
      boot: ReturnType<typeof stats>;
      verifyOk: number;
      verifyFail: number;
    }[] = [];

    for (const tier of TIERS) {
      if (global.gc) global.gc();

      const batchStart = performance.now();

      // Boot N isolates concurrently
      const bootTimings: number[] = [];
      const tierIsolates: IsolateHandle[] = [];

      const bootResults = await Promise.allSettled(
        Array.from({ length: tier }, async (_, i) => {
          const id = allIsolates.length + i;
          const t0 = performance.now();
          const kv = createMockKv();
          const isolate = await _internals.startIsolate(makeAgentBundle(id), kv, {});
          bootTimings.push(performance.now() - t0);
          return isolate;
        }),
      );

      const batchMs = performance.now() - batchStart;

      for (const r of bootResults) {
        if (r.status === "fulfilled") {
          tierIsolates.push(r.value);
          allIsolates.push(r.value);
        }
      }

      if (global.gc) global.gc();
      const rss = rssMb();

      // Verify each new isolate works: connect session + call tool
      let verifyOk = 0;
      let verifyFail = 0;

      for (const iso of tierIsolates) {
        try {
          await iso.channel.call(
            { type: "hook", hook: "onConnect", sessionId: "v" },
            TOOL_TIMEOUT_MS,
          );
          const result = await iso.channel.call<{ result: string }>(
            { type: "tool", name: "ping", sessionId: "v", args: {}, messages: [] },
            TOOL_TIMEOUT_MS,
          );
          if (result.result.startsWith("pong-")) verifyOk++;
          else verifyFail++;
        } catch {
          verifyFail++;
        }
      }

      const bootStats = stats(bootTimings);
      results.push({
        concurrency: tier,
        rssMb: rss,
        batchMs,
        boot: bootStats,
        verifyOk,
        verifyFail,
      });

      console.log(
        `${String(tier).padStart(3)} concurrent | ` +
          `RSS ${rss.toFixed(0).padStart(5)}MB | ` +
          `boot p50 ${bootStats.p50.toFixed(0).padStart(5)}ms ` +
          `p95 ${bootStats.p95.toFixed(0).padStart(5)}ms ` +
          `max ${bootStats.max.toFixed(0).padStart(5)}ms | ` +
          `batch ${batchMs.toFixed(0).padStart(5)}ms | ` +
          `verify ${verifyOk}/${tier}`,
      );
    }

    // Summary
    console.log("\n--- Summary ---");
    console.log(
      "N".padStart(4),
      "RSS(MB)".padStart(8),
      "p50(ms)".padStart(8),
      "p95(ms)".padStart(8),
      "max(ms)".padStart(8),
      "batch".padStart(8),
      "verify".padStart(8),
    );
    console.log("-".repeat(54));
    for (const r of results) {
      console.log(
        String(r.concurrency).padStart(4),
        r.rssMb.toFixed(0).padStart(8),
        r.boot.p50.toFixed(0).padStart(8),
        r.boot.p95.toFixed(0).padStart(8),
        r.boot.max.toFixed(0).padStart(8),
        r.batchMs.toFixed(0).padStart(8),
        `${r.verifyOk}/${r.concurrency}`.padStart(8),
      );
    }

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.verifyFail).toBe(0);
  }, 120_000);
});
