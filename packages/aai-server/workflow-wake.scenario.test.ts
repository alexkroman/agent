// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable-run wake path against a REAL Postgres — BOTH ends of it.
 *
 * `workflow-wake.test.ts` drives the sweep through a fake connection, which can
 * only check policy: who gets woken, how often, and what a 404 means. Every
 * claim that decides whether a parked run resumes AT ALL is a claim about SQL,
 * and both halves of it are written in different packages:
 *
 * - the guest's hint (`aai/host/workflow-wake-hint.ts`) reduces a graphile-worker
 *   queue to one timestamp — excluding a permanently-failed job, and dating a
 *   locked one from its lock expiry rather than its `run_at`;
 * - the platform's read (`workflow-wake.ts`) filters on the DATABASE's clock,
 *   reads across per-app schemas it names by hash, and isolates each tenant's
 *   read in a savepoint.
 *
 * Neither can be checked by a fake: a fake holds JS values, so "does this SQL
 * really exclude an exhausted job" and "does one tenant's broken table cost the
 * others their wake" are exactly the questions it answers by construction. The
 * two ends are also only correct TOGETHER — the guest writes what the platform
 * reads — which is why one file exercises both rather than each package testing
 * its own half against its own assumptions.
 *
 * The `graphile_worker.jobs` view is stood up by hand here (the four columns the
 * hint reads), because installing the DevKit's world would pull its whole
 * migration set for a query that only needs the shape.
 *
 * Runs in the integration tier (`pnpm test:integration`) against
 * `AAI_TEST_PG_URL`. Core Postgres only — no extensions.
 */

import {
  type CloseableDb,
  createPostgresDb,
  createWakeHintPublisher,
  type ReservedDb,
  WORKFLOW_WAKE_TABLE,
} from "@alexkroman1/aai/runtime";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { appDbIdentifier } from "./app-database.ts";
import type { BrokeredSession } from "./sandbox-broker.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { createTestStore } from "./test-utils.ts";
import { createWorkflowWakeSweep } from "./workflow-wake.ts";

/**
 * A `run_at` unambiguously in the past.
 *
 * A literal near today's date would make every "is it due" assertion depend on
 * the hour the suite runs — the shape of flake that reads as a bug in the code
 * under test.
 */
const PAST = "2020-01-01T00:00:00Z";

/** The slug whose app schema everything below is written into. */
const SLUG = "wake-test-agent";
/** A second app, for the cross-tenant isolation property. */
const OTHER_SLUG = "wake-test-neighbour";

const OK: BrokeredSession = {
  ok: true,
  sessionUrl: "wss://sandbox.test/websocket",
  guestOrigin: "wss://sandbox.test",
};

describeWithPg("durable-run wake over a real Postgres", () => {
  let admin: CloseableDb;
  /** A session pinned to the app's schema — what the GUEST's connection is. */
  let guest: ReservedDb;
  let url: string;

  const schema = appDbIdentifier(SLUG);
  const otherSchema = appDbIdentifier(OTHER_SLUG);

  /** Insert one job into the fake queue. */
  async function addJob(job: {
    runAt: string;
    lockedAt?: string | null;
    attempts?: number;
    maxAttempts?: number;
  }): Promise<void> {
    await admin.query(
      `insert into graphile_worker.jobs (run_at, locked_at, attempts, max_attempts)
       values ($1::timestamptz, $2::timestamptz, $3, $4)`,
      [job.runAt, job.lockedAt ?? null, job.attempts ?? 0, job.maxAttempts ?? 3],
    );
  }

  /** What the guest would publish right now. */
  async function publish(): Promise<void> {
    await createWakeHintPublisher({ db: guest, intervalMs: 0 }).publish();
  }

  /**
   * The hint as stored: an ISO string, `null` for "nothing pending", or
   * `undefined` when the guest wrote nothing at all — the third state, which is
   * what "no queue in this database" has to look like, and is why the table's
   * absence is read here rather than thrown.
   */
  async function storedHint(): Promise<string | null | undefined> {
    const present = await admin.query<{ present: boolean }>(
      `select to_regclass('"${schema}"."${WORKFLOW_WAKE_TABLE}"') is not null as present`,
    );
    if (present[0]?.present !== true) return;
    const rows = await admin.query<{ wake_at: Date | null }>(
      `select wake_at from "${schema}"."${WORKFLOW_WAKE_TABLE}"`,
    );
    if (rows.length === 0) return;
    return rows[0]?.wake_at?.toISOString() ?? null;
  }

  /** One sweep pass, returning the slugs it woke. */
  async function sweep(slugs: string[] = [SLUG, OTHER_SLUG]): Promise<string[]> {
    const wake = vi.fn(() => Promise.resolve(OK));
    const store = createTestStore();
    store.listSlugs = () => Promise.resolve(slugs);
    const result = await createWorkflowWakeSweep({
      adminDb: admin,
      store,
      broker: { slots: createSlotCache(), store: createTestStore() },
      wake,
      // No backoff: each test is one pass, and the backoff is unit-tested.
      retryMs: 0,
    }).sweepOnce();
    // Thrown rather than asserted: an `expect` outside a test body reports as a
    // suite-level crash with no test name attached (and biome's
    // `noMisplacedAssertion` rejects it) — the same rule
    // `platform-db-budget.test.ts` follows for its own helper.
    if (!result.swept) throw new Error("sweep did not run — the advisory lock was already held");
    return result.woken;
  }

  beforeAll(async () => {
    url = pgUrl();
    admin = createPostgresDb({ url, max: 4 });
    await admin.query(`create schema if not exists "${schema}"`);
    await admin.query(`create schema if not exists "${otherSchema}"`);
    // The four columns the hint query reads, as graphile-worker's own `jobs`
    // view exposes them.
    await admin.query("create schema if not exists graphile_worker");
    await admin.query(`create table if not exists graphile_worker.jobs (
      id bigserial primary key,
      run_at timestamptz not null default now(),
      locked_at timestamptz,
      attempts int not null default 0,
      max_attempts int not null default 3
    )`);
    guest = await admin.reserve();
    // What the platform pins on the app role at provisioning time, so the
    // guest's unqualified DDL lands in its own schema (app-database.ts).
    await guest.query(`set search_path = "${schema}"`);
  });

  afterAll(async () => {
    guest.release();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.query(`drop schema if exists "${otherSchema}" cascade`);
    await admin.query("drop schema if exists graphile_worker cascade");
    await admin.close();
  });

  beforeEach(async () => {
    await admin.query("delete from graphile_worker.jobs");
    await admin.query(`drop table if exists "${schema}"."${WORKFLOW_WAKE_TABLE}"`);
    await admin.query(`drop table if exists "${otherSchema}"."${WORKFLOW_WAKE_TABLE}"`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a job due in the past is published and swept as due", async () => {
    await addJob({ runAt: PAST });
    await publish();

    expect(await storedHint()).toBe(new Date(PAST).toISOString());
    expect(await sweep()).toEqual([SLUG]);
  });

  test("a job scheduled for the future is published but not due", async () => {
    // The sleeping-run case: the hint exists, and the platform must leave it
    // alone until its time comes.
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    await addJob({ runAt: soon });
    await publish();

    expect(await storedHint()).toBe(new Date(soon).toISOString());
    expect(await sweep()).toEqual([]);
  });

  test("a permanently-failed job counts for nothing", async () => {
    // Its run_at is forever in the past, so counting it would boot a sandbox
    // every sweep for the life of the agent.
    await addJob({ runAt: PAST, attempts: 3, maxAttempts: 3 });
    await publish();

    expect(await storedHint()).toBeNull();
    expect(await sweep()).toEqual([]);
  });

  test("a freshly locked job is dated from its lock expiry, not its run_at", async () => {
    // It belongs to a worker. The earliest ANOTHER worker may claim it is
    // graphile-worker's 4-hour job expiry past the lock.
    const now = new Date();
    await addJob({ runAt: PAST, lockedAt: now.toISOString() });
    await publish();

    const hint = await storedHint();
    expect(hint).not.toBeNull();
    expect(new Date(hint as string).getTime() - now.getTime()).toBeCloseTo(4 * 3_600_000, -4);
    expect(await sweep()).toEqual([]);
  });

  test("a job whose lock has expired is due again", async () => {
    // The lost-step case: the container died mid-step. Nobody could rescue the
    // job before the expiry, and once it lapses the wake is what brings a worker
    // back to rescue it.
    const stale = new Date(Date.now() - 5 * 3_600_000).toISOString();
    await addJob({ runAt: PAST, lockedAt: stale });
    await publish();

    expect(await sweep()).toEqual([SLUG]);
  });

  test("an empty queue publishes null, which is what stops the waking", async () => {
    await addJob({ runAt: PAST });
    await publish();
    expect(await sweep()).toEqual([SLUG]);

    await admin.query("delete from graphile_worker.jobs");
    await publish();

    // Null rather than a deleted row: an absent row and "nothing pending" would
    // otherwise be indistinguishable to the platform.
    expect(await storedHint()).toBeNull();
    expect(await sweep()).toEqual([]);
  });

  test("no queue in the database means no hint table at all", async () => {
    // The Local World under `aai dev`, or a world that failed to start.
    await admin.query("alter schema graphile_worker rename to graphile_worker_hidden");
    try {
      await publish();
      expect(await storedHint()).toBeUndefined();
      expect(await sweep()).toEqual([]);
    } finally {
      await admin.query("alter schema graphile_worker_hidden rename to graphile_worker");
    }
  });

  test("an agent the agents table no longer lists is never woken", async () => {
    // Its schema outlives its row until the orphan sweep runs.
    await addJob({ runAt: PAST });
    await publish();

    expect(await sweep([OTHER_SLUG])).toEqual([]);
  });

  test("one tenant's unreadable hint table does not cost another its wake", async () => {
    // A savepoint per read is what makes this true. Without one, the neighbour's
    // failing statement aborts the pass's transaction and every later tenant is
    // skipped — a cross-tenant denial of the one mechanism a parked run has.
    await admin.query(
      `create table "${otherSchema}"."${WORKFLOW_WAKE_TABLE}" (nothing_useful int)`,
    );
    await addJob({ runAt: PAST });
    await publish();

    expect(await sweep()).toEqual([SLUG]);
  });

  test("the guest's DDL is idempotent across boots", async () => {
    // Every boot of every workflow guest runs it, and two concurrent creates of
    // one name take conflicting locks — which is why the publisher memoizes on
    // the promise rather than on a flag set afterwards.
    await addJob({ runAt: PAST });
    await publish();
    await publish();
    await createWakeHintPublisher({ db: guest, intervalMs: 0 }).publish();

    const rows = await admin.query<{ count: string }>(
      `select count(*) as count from "${schema}"."${WORKFLOW_WAKE_TABLE}"`,
    );
    // One row, whatever happens: the table's primary key admits only `true`.
    expect(Number(rows[0]?.count)).toBe(1);
  });

  test("the one-row invariant is enforced by the table, not by the writer", async () => {
    await publish();
    await expect(
      admin.query(
        `insert into "${schema}"."${WORKFLOW_WAKE_TABLE}" (id, wake_at) values (false, now())`,
      ),
    ).rejects.toThrow();
  });
});
