// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent surface's rate limits, over the arm that decides whether they mean
 * anything: a real Postgres shared by more than one limiter instance.
 *
 * **The claim under test is not "the limiter counts" — it is "the limit is the
 * number written down".** Every other spec for this code builds ONE limiter, so
 * every one of them passes just as well against the in-memory implementation,
 * which is per-process. That is exactly how the composition root
 * (`aai-studio-server/index.ts`) came to pass `deployRateLimiter` and neither
 * workflow limiter for months: `createWorkflowRateLimitMw` fell through to
 * `?? createRateLimiter(…)`, the middleware's own specs injected limiters and so
 * never saw the default, and at `MAX_CONTAINERS = 3` the 600/IP surface window
 * was enforcing 1,800 and the 60/IP start window 180. Nothing was red.
 *
 * So the shape here is always TWO instances, standing in for two replicas, and
 * the assertion is that the second one is bound by what the first spent. The
 * in-memory contrast — two instances that do NOT share — is asserted in
 * `rate-limit.test.ts`, which runs everywhere; without it a reader cannot tell
 * this file is testing anything.
 *
 * ```sh
 * pnpm test:pg   # resolves a local database, then runs this tier against it
 * ```
 *
 * Writes only under keys carrying this process's own prefix, and sweeps exactly
 * those in `afterAll` — the local database is shared with other suites and with
 * a developer's real projects, and the row names here are the PRODUCTION
 * limiter names, so scoping the sweep by key rather than by name is the whole
 * of the safety.
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { UNKNOWN_CLIENT_IP } from "./client-ip.ts";
import { ensurePlatformTables } from "./platform-schema-test-utils.ts";
import {
  createPgAgentRateLimiters,
  createPgRateLimiter,
  createRateLimiter,
  WORKFLOW_START_IP_RATE_LIMIT,
} from "./rate-limit.ts";
import type { SqlExec } from "./secret-store.ts";

/** Every key this file mints. The sweep matches this and nothing else. */
const KEY_PREFIX = `rl-scenario-${process.pid}-`;

describeWithPg("the agent surface's rate limits, across replicas", () => {
  let close: () => Promise<void>;
  let sql: SqlExec;
  let n = 0;
  /** A key no other suite, and no earlier test here, can be counting against. */
  const key = (label: string): string => `${KEY_PREFIX}${label}-${n++}`;

  /** What the table actually holds for a key — the shared state itself. */
  const counted = async (name: string, forKey: string): Promise<number> => {
    const rows = await sql(
      "select count from aai_platform.studio_rate_limits where name = $1 and key = $2",
      [name, forKey],
    );
    return Number(rows[0]?.count ?? 0);
  };

  beforeAll(async () => {
    // `pgUrl()` inside the hook, never at the top of this body: vitest EXECUTES
    // a skipped describe callback to enumerate it, so up there it throws during
    // collection instead of skipping the file.
    const db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (query, params) => db.query(query, params);
    close = () => db.close();
    await ensurePlatformTables(sql);
  });

  afterAll(async () => {
    await sql("delete from aai_platform.studio_rate_limits where key like $1", [`${KEY_PREFIX}%`]);
    await close?.();
  });

  test("two instances over one database share a BUDGET, where two in memory do not", async () => {
    const opts = { name: "rl-scenario", limit: 1, windowMs: 60_000 };
    const replicaA = createPgRateLimiter(sql, opts);
    const replicaB = createPgRateLimiter(sql, opts);
    const durable = key("shared");
    await expect(replicaA.check(durable)).resolves.toEqual({ ok: true });
    // The whole point: B never saw this key and refuses it anyway.
    expect((await replicaB.check(durable)).ok).toBe(false);

    // The same two replicas without the database — the state production was in.
    const memoryA = createRateLimiter(opts);
    const memoryB = createRateLimiter(opts);
    await expect(memoryA.check("memory")).resolves.toEqual({ ok: true });
    await expect(memoryB.check("memory")).resolves.toEqual({ ok: true });
  });

  test("EVERY limiter the composition root passes counts across replicas", async () => {
    // Two calls to the factory = two replicas booting against one platform
    // database. Asserted per option name rather than for one of them, because
    // the bug this file exists for was a SUBSET of them being wired.
    const [replicaA, replicaB] = [createPgAgentRateLimiters(sql), createPgAgentRateLimiters(sql)];
    // Option name → the `name` its rows carry. Written out rather than derived,
    // so a rename of either half has to be made deliberately in both.
    const rowName = {
      deployRateLimiter: "deploy-ip",
      workflowRateLimiter: "workflow-ip",
      workflowStartRateLimiter: "workflow-start-ip",
    };
    for (const option of Object.keys(rowName) as (keyof typeof rowName)[]) {
      const shared = key(option);
      await replicaA[option].check(shared);
      await replicaB[option].check(shared);
      // Counting is what a limit is made of, and these windows are too generous
      // (600, 60, 60) to exhaust three times over; the row is the same evidence
      // without the round trips. The REFUSAL crossing replicas is below.
      expect(await counted(rowName[option], shared)).toBe(2);
    }
  });

  test("the tightest window refuses at its configured number, counting BOTH replicas", async () => {
    // The one route on the surface whose cost outlives its request, at the limit
    // it actually ships with. Split across the two replicas so the refusal can
    // only come from shared state: neither has spent the limit by itself.
    const [replicaA, replicaB] = [createPgAgentRateLimiters(sql), createPgAgentRateLimiters(sql)];
    const shared = key("start-exhaust");
    const half = Math.floor(WORKFLOW_START_IP_RATE_LIMIT.limit / 2);
    for (let i = 0; i < half; i += 1) {
      expect((await replicaA.workflowStartRateLimiter.check(shared)).ok).toBe(true);
    }
    for (let i = half; i < WORKFLOW_START_IP_RATE_LIMIT.limit; i += 1) {
      expect((await replicaB.workflowStartRateLimiter.check(shared)).ok).toBe(true);
    }
    // Neither replica has spent more than half the window, and both are done.
    const verdict = await replicaA.workflowStartRateLimiter.check(shared);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect((await replicaB.workflowStartRateLimiter.check(shared)).ok).toBe(false);
  });

  test("a header-less caller's shared bucket is now fleet-wide, which cuts both ways", async () => {
    // `clientIp` answers the literal `unknown` with no X-Forwarded-For
    // (client-ip.test.ts pins that), and making these limiters durable makes
    // that ONE bucket for the whole fleet rather than one per replica. Stricter,
    // and the documented trade — a shared bucket over-limits rather than opening
    // — but it also means one such caller can spend every other one's budget.
    // Modal's proxy always appends a hop, so production never lands here; a
    // deployment fronted by a proxy that STRIPS the header would.
    const opts = { name: "rl-scenario-unknown", limit: 1, windowMs: 60_000 };
    const [replicaA, replicaB] = [createPgRateLimiter(sql, opts), createPgRateLimiter(sql, opts)];
    const shared = `${key("unknown")}-${UNKNOWN_CLIENT_IP}`;
    await expect(replicaA.check(shared)).resolves.toEqual({ ok: true });
    expect((await replicaB.check(shared)).ok).toBe(false);
  });
});
