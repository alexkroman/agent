// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: KV Store Corruption Under Extreme Load
 *
 * Boots a MinIO container, creates an unstorage S3-backed KV store,
 * and hammers it with concurrent reads/writes/deletes across multiple
 * keys and agents. Verifies no data corruption, lost writes, or stale reads.
 *
 * Requires Docker. Run:
 *   pnpm vitest run --config packages/aai-server/load/vitest.load.config.ts kv-corruption
 */

import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createStorage, type Storage } from "unstorage";
import s3Driver from "unstorage/drivers/s3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createUnstorageKv } from "../../aai-core/host/unstorage-kv.ts";
import type { Kv } from "../../aai-core/sdk/kv.ts";

// ── MinIO setup ─────────────────────────────────────────────────────────

let minio: StartedTestContainer;
let storage: Storage;
const BUCKET = "kv-corruption-test";

beforeAll(async () => {
  minio = await new GenericContainer("minio/minio")
    .withCommand(["server", "/data"])
    .withExposedPorts(9000)
    .withEnvironment({
      MINIO_ROOT_USER: "minioadmin",
      MINIO_ROOT_PASSWORD: "minioadmin",
    })
    .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000).forStatusCode(200))
    .start();

  // Create bucket by mkdir on the data volume (MinIO uses filesystem-backed storage)
  await minio.exec(["mkdir", "-p", `/data/${BUCKET}`]);

  const host = minio.getHost();
  const port = minio.getMappedPort(9000);
  const endpoint = `http://${host}:${port}`;

  storage = createStorage({
    driver: s3Driver({
      bucket: BUCKET,
      endpoint,
      region: "us-east-1",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    }),
  });
}, 60_000);

afterAll(async () => {
  await minio?.stop().catch(() => {
    /* noop */
  });
}, 30_000);

// ── Helpers ─────────────────────────────────────────────────────────────

function makeKv(prefix: string): Kv {
  return createUnstorageKv({ storage, prefix });
}

function _rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("KV corruption under extreme load", () => {
  test("concurrent writes to same key converge", async () => {
    const kv = makeKv("agents/converge-test/kv");
    const WRITERS = 50;
    const ROUNDS = 10;

    console.log(`\n--- Concurrent writes: ${WRITERS} writers x ${ROUNDS} rounds ---`);

    for (let round = 0; round < ROUNDS; round++) {
      // All writers set the same key concurrently
      await Promise.all(
        Array.from({ length: WRITERS }, (_, i) =>
          kv.set("shared-key", { writer: i, round, ts: Date.now() }),
        ),
      );

      // Read should return one of the written values (no corruption)
      const result = await kv.get<{ writer: number; round: number }>("shared-key");
      expect(result).toBeTruthy();
      expect(result?.round).toBe(round);
      expect(result?.writer).toBeGreaterThanOrEqual(0);
      expect(result?.writer).toBeLessThan(WRITERS);
    }

    console.log(`  All ${ROUNDS} rounds converged — no corruption detected`);
  }, 30_000);

  test("concurrent read/write doesn't return partial data", async () => {
    const kv = makeKv("agents/partial-test/kv");
    const OPS = 100;
    const VALUE_SIZE = 1000; // Large enough to detect partial reads

    console.log(`\n--- Concurrent read/write: ${OPS} ops ---`);

    // Pre-seed keys
    const keys = Array.from({ length: 20 }, (_, i) => `key-${i}`);
    for (const key of keys) {
      await kv.set(key, { data: "x".repeat(VALUE_SIZE), version: 0 });
    }

    // Fire concurrent reads and writes
    let corruptionCount = 0;
    const results = await Promise.allSettled(
      Array.from({ length: OPS }, (_, i) => {
        const key = keys[i % keys.length]!;
        if (i % 3 === 0) {
          // Write
          return kv.set(key, { data: "y".repeat(VALUE_SIZE), version: i });
        }
        // Read and verify integrity
        return kv.get<{ data: string; version: number }>(key).then((val) => {
          if (val) {
            // Check for partial/corrupt data
            const char = val.data[0];
            const allSame = val.data === char?.repeat(VALUE_SIZE);
            if (!allSame) {
              corruptionCount++;
              console.error(`CORRUPTION at ${key}: mixed chars in data field`);
            }
          }
          return val;
        });
      }),
    );

    const failures = results.filter((r) => r.status === "rejected").length;
    console.log(`  ${OPS} ops: ${failures} failures, ${corruptionCount} corruptions`);
    expect(corruptionCount).toBe(0);
  }, 30_000);

  test("delete during concurrent reads doesn't crash", async () => {
    const kv = makeKv("agents/delete-test/kv");
    const KEYS = 50;
    const OPS_PER_KEY = 10;

    console.log(`\n--- Delete during reads: ${KEYS} keys x ${OPS_PER_KEY} ops ---`);

    // Seed all keys
    for (let i = 0; i < KEYS; i++) {
      await kv.set(`del-${i}`, { value: i });
    }

    // Fire concurrent reads and deletes
    let readCount = 0;
    let deleteCount = 0;
    let nullCount = 0;

    const ops = [];
    for (let i = 0; i < KEYS; i++) {
      for (let j = 0; j < OPS_PER_KEY; j++) {
        if (j === OPS_PER_KEY - 1) {
          // Last op is a delete
          ops.push(
            kv.delete(`del-${i}`).then(() => {
              deleteCount++;
            }),
          );
        } else {
          // Read
          ops.push(
            kv.get(`del-${i}`).then((val) => {
              readCount++;
              if (val === null) nullCount++;
            }),
          );
        }
      }
    }

    await Promise.allSettled(ops);

    console.log(`  ${readCount} reads (${nullCount} null), ${deleteCount} deletes — no crashes`);
    // Some reads may return null (deleted), that's fine
    expect(deleteCount).toBe(KEYS);
  }, 30_000);

  test("multi-agent isolation under contention", async () => {
    const AGENTS = 10;
    const OPS_PER_AGENT = 50;

    console.log(`\n--- Multi-agent isolation: ${AGENTS} agents x ${OPS_PER_AGENT} ops ---`);

    const kvs = Array.from({ length: AGENTS }, (_, i) => makeKv(`agents/agent-${i}/kv`));

    // Each agent writes to its own namespace concurrently
    await Promise.all(
      kvs.map(async (kv, agentIdx) => {
        for (let i = 0; i < OPS_PER_AGENT; i++) {
          await kv.set(`data-${i}`, { agent: agentIdx, seq: i });
        }
      }),
    );

    // Verify each agent only sees its own data
    let crossContamination = 0;
    for (let agentIdx = 0; agentIdx < AGENTS; agentIdx++) {
      const kv = kvs[agentIdx]!;
      for (let i = 0; i < OPS_PER_AGENT; i++) {
        const val = await kv.get<{ agent: number; seq: number }>(`data-${i}`);
        expect(val).toBeTruthy();
        if (val?.agent !== agentIdx) {
          crossContamination++;
          console.error(
            `CROSS-CONTAMINATION: agent-${agentIdx} read data from agent-${val?.agent}`,
          );
        }
        expect(val?.seq).toBe(i);
      }
    }

    console.log(
      `  ${AGENTS * OPS_PER_AGENT} writes + ${AGENTS * OPS_PER_AGENT} reads — ` +
        `${crossContamination} cross-contaminations`,
    );
    expect(crossContamination).toBe(0);
  }, 30_000);

  test("high-throughput burst with verification", async () => {
    const kv = makeKv("agents/burst-test/kv");
    const BURST_SIZE = 500;

    console.log(`\n--- High-throughput burst: ${BURST_SIZE} ops ---`);

    const t0 = performance.now();

    // Write burst
    await Promise.all(
      Array.from({ length: BURST_SIZE }, (_, i) =>
        kv.set(`burst-${i}`, { idx: i, payload: "x".repeat(100) }),
      ),
    );
    const writeMs = performance.now() - t0;

    // Read burst and verify all
    const t1 = performance.now();
    const values = await Promise.all(
      Array.from({ length: BURST_SIZE }, (_, i) =>
        kv.get<{ idx: number; payload: string }>(`burst-${i}`),
      ),
    );
    const readMs = performance.now() - t1;

    let missing = 0;
    let corrupt = 0;
    for (let i = 0; i < BURST_SIZE; i++) {
      const val = values[i];
      if (!val) {
        missing++;
      } else if (val.idx !== i || val.payload !== "x".repeat(100)) {
        corrupt++;
      }
    }

    const writeOps = BURST_SIZE / (writeMs / 1000);
    const readOps = BURST_SIZE / (readMs / 1000);

    console.log(`  Write: ${writeMs.toFixed(0)}ms (${writeOps.toFixed(0)} ops/s)`);
    console.log(`  Read:  ${readMs.toFixed(0)}ms (${readOps.toFixed(0)} ops/s)`);
    console.log(`  Missing: ${missing}, Corrupt: ${corrupt} of ${BURST_SIZE}`);

    expect(missing).toBe(0);
    expect(corrupt).toBe(0);
  }, 30_000);

  test("delete-then-read consistency", async () => {
    const kv = makeKv("agents/delete-read-test/kv");
    const KEYS = 100;

    console.log(`\n--- Delete-then-read consistency: ${KEYS} keys ---`);

    // Write all keys
    await Promise.all(Array.from({ length: KEYS }, (_, i) => kv.set(`item-${i}`, { idx: i })));

    // Delete odd keys concurrently
    await Promise.all(
      Array.from({ length: KEYS }, (_, i) =>
        i % 2 === 1 ? kv.delete(`item-${i}`) : Promise.resolve(),
      ),
    );

    // Read all keys — even should exist, odd should be null
    const reads = await Promise.all(
      Array.from({ length: KEYS }, (_, i) =>
        kv.get<{ idx: number }>(`item-${i}`).then((val) => ({ idx: i, val })),
      ),
    );

    let correctEven = 0;
    let correctOdd = 0;
    let errors = 0;
    for (const { idx, val } of reads) {
      if (idx % 2 === 0) {
        if (val && val.idx === idx) correctEven++;
        else errors++;
      } else if (val === null) correctOdd++;
      else errors++;
    }

    console.log(
      `  Even keys present: ${correctEven}/${KEYS / 2}, ` +
        `Odd keys deleted: ${correctOdd}/${KEYS / 2}, ` +
        `Errors: ${errors}`,
    );

    expect(correctEven).toBe(KEYS / 2);
    expect(correctOdd).toBe(KEYS / 2);
    expect(errors).toBe(0);
  }, 30_000);
});
