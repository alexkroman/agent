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
 * Runs in the scenario tier (`pnpm test:scenario`), gated on the STACK rather
 * than on a database — because `seedVault` below writes through the real
 * Supabase Vault, which only the Supabase image has. Gated on `describeWithPg`
 * it did not skip on a plain server, it FAILED: `pnpm test:pg` resolves a stock
 * local Postgres as a legitimate narrow arm (`with-test-pg.mjs`), and there
 * `beforeAll` died on `relation "vault.secrets" does not exist` before a single
 * assertion ran. A gate answers "can this arm run", so an arm that cannot has
 * to be an announced skip and never a red test — the same reason every other
 * Vault-touching suite here (`pg-cron`, `platform-schema`, `store-conformance`)
 * is stack-gated. CI still runs this: its platform-stack job runs the whole
 * scenario tier with the stack up.
 */

import { type CloseableDb, createPostgresDb } from "@alexkroman1/aai-runtime";
import { createWakeHintPublisher, WORKFLOW_WAKE_TABLE } from "@alexkroman1/aai-runtime/internal";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { describeWithStack, pgUrl } from "./_pg-test-utils.ts";
import {
  APP_DB_SCHEMA,
  type AppDatabases,
  type AppDbMeta,
  appDbIdentifier,
  createAppDatabases,
} from "./app-database.ts";
import type { BrokeredSession } from "./sandbox-broker.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { APP_DB_SECRET_PREFIX, createVaultSecretStore } from "./secret-store.ts";
import { createTestStore, fakeDatabaseAdmin } from "./test-utils.ts";
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

describeWithStack("durable-run wake over a real Postgres", () => {
  /** The PLATFORM database's connection — what elects the leader. */
  let admin: CloseableDb;
  /** A connection into the APP's OWN database — what the GUEST's connection is. */
  let guest: CloseableDb;
  /** The sweep's way into any app's database. */
  let appDb: AppDatabases;
  let url: string;

  /** Database names, which are also the role names (`app-database.ts`). */
  const appName = appDbIdentifier(SLUG);
  const otherName = appDbIdentifier(OTHER_SLUG);

  /** Swap a database name into the platform admin URL. */
  function urlFor(database: string): string {
    const parsed = new URL(url);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  }

  /** A meta pointing at one app's real database on this cluster. */
  function metaFor(slug: string): AppDbMeta {
    return { role: appDbIdentifier(slug), password: "unused-by-admin-reads", url };
  }

  /** Insert one job into the fake queue — INSIDE the app's own database. */
  async function addJob(job: {
    runAt: string;
    lockedAt?: string | null;
    attempts?: number;
    maxAttempts?: number;
  }): Promise<void> {
    await guest.query(
      `insert into graphile_worker.jobs (run_at, locked_at, attempts, max_attempts)
       values ($1::timestamptz, $2::timestamptz, $3, $4)`,
      [job.runAt, job.lockedAt ?? null, job.attempts ?? 0, job.maxAttempts ?? 3],
    );
  }

  /** What the guest would publish right now. */
  async function publish(): Promise<void> {
    const reserved = await guest.reserve();
    try {
      await createWakeHintPublisher({ db: reserved, intervalMs: 0 }).publish();
    } finally {
      reserved.release();
    }
  }

  /**
   * The hint as stored: an ISO string, `null` for "nothing pending", or
   * `undefined` when the guest wrote nothing at all — the third state, which is
   * what "no queue in this database" has to look like, and is why the table's
   * absence is read here rather than thrown.
   */
  async function storedHint(): Promise<string | null | undefined> {
    const present = await guest.query<{ present: boolean }>(
      `select to_regclass('${APP_DB_SCHEMA}.${WORKFLOW_WAKE_TABLE}') is not null as present`,
    );
    if (present[0]?.present !== true) return;
    const rows = await guest.query<{ wake_at: Date | null }>(
      `select wake_at from ${APP_DB_SCHEMA}.${WORKFLOW_WAKE_TABLE}`,
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
      appDb,
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

  /**
   * The REAL Supabase Vault, not a stand-in.
   *
   * The stack has one (`supabase_vault` is in the local image) — which is what
   * `describeWithStack` above exists to guarantee — and the sweep
   * reads `vault.decrypted_secrets` directly — so a hand-rolled table would test
   * a view of our own shape rather than the one production queries. It is also
   * not creatable here: `create schema vault` fails `permission denied` against
   * the schema Supabase already owns.
   */
  async function seedVault(slugs: string[]): Promise<void> {
    const vault = createVaultSecretStore((query, params) => admin.query(query, params));
    for (const slug of slugs) {
      await vault.put(`${APP_DB_SECRET_PREFIX}${slug}`, JSON.stringify(metaFor(slug)));
    }
  }

  beforeAll(async () => {
    url = pgUrl();
    admin = createPostgresDb({ url, max: 4 });

    // Real per-app DATABASES — the whole point of the change under test. Owned by
    // the admin role, exactly as `provisionAppDatabase` creates them, so the
    // sweep's own connection can read them and the drop needs no ownership dance.
    for (const name of [appName, otherName]) {
      await admin.query(`drop database if exists "${name}" with (force)`);
      await admin.query(`create database "${name}"`);
    }
    await seedVault([SLUG, OTHER_SLUG]);

    guest = createPostgresDb({ url: urlFor(appName), max: 2 });
    // graphile_worker lives in the APP's database now — which is exactly what the
    // per-schema model could not express, since `graphile_worker` is a
    // database-level name (see app-database.ts).
    await guest.query("create schema if not exists graphile_worker");
    await guest.query(`create table if not exists graphile_worker.jobs (
      id bigserial primary key,
      run_at timestamptz not null default now(),
      locked_at timestamptz,
      attempts int not null default 0,
      max_attempts int not null default 3
    )`);

    appDb = createAppDatabases({
      url,
      sql: (query, params) => admin.query(query, params),
      open: (appUrl) => {
        const db = createPostgresDb({ url: appUrl, max: 1 });
        return { query: (query, params) => db.query(query, params), close: () => db.close() };
      },
      // Create/drop are Supabase Management API calls, and this stack is a local
      // Postgres with no control plane — so the two databases above are made by
      // hand and this suite never provisions through the channel. A recording
      // fake keeps that explicit rather than reaching for a live token.
      admin: fakeDatabaseAdmin(),
    });
  });

  afterAll(async () => {
    // Defensive: a failure in `beforeAll` still runs this, and an unclosed pool
    // or a leftover database would leak into every later run on this stack.
    await guest?.close();
    if (admin !== undefined) {
      const vault = createVaultSecretStore((query, params) => admin.query(query, params));
      for (const slug of [SLUG, OTHER_SLUG]) {
        await vault.delete(`${APP_DB_SECRET_PREFIX}${slug}`).catch(() => undefined);
      }
      for (const name of [appName, otherName]) {
        await admin.query(`drop database if exists "${name}" with (force)`).catch(() => undefined);
      }
      await admin.close();
    }
  });

  beforeEach(async () => {
    await guest.query("delete from graphile_worker.jobs");
    await guest.query(`drop table if exists ${APP_DB_SCHEMA}.${WORKFLOW_WAKE_TABLE}`);
    const other = createPostgresDb({ url: urlFor(otherName), max: 1 });
    await other.query(`drop table if exists ${APP_DB_SCHEMA}.${WORKFLOW_WAKE_TABLE}`);
    await other.close();
  });

  // No `afterEach(vi.restoreAllMocks)`: `restoreMocks: true` in
  // `vitest.shared.ts` restores every `vi.spyOn` before each test already, so
  // the hook was dead structure.

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

  test("a freshly locked job is dated from its LOCK, so a boot can rescue it", async () => {
    // This used to be dated from the lock's 4-hour expiry — graphile-worker's own
    // answer, since it lets no OTHER worker claim a locked job until then. But
    // publishing that answer DEADLOCKS against our own recovery: the guest's
    // startup lock sweep is what clears a dead worker's locks, so a boot is
    // precisely what makes such a job claimable, and "nothing for four hours"
    // told the platform not to boot. Measured: SIGKILL a guest mid-step and the
    // run sat `running` with no wake, while the same kill seconds earlier — hint
    // still on the unlocked branch — recovered within one sweep.
    //
    // A live worker's lock is not a problem either: its sandbox is alive, so the
    // wake resolves to the resident and costs a broker call bounded by the
    // per-slug backoff.
    const now = new Date();
    await addJob({ runAt: PAST, lockedAt: now.toISOString() });
    await publish();

    const hint = await storedHint();
    expect(hint).toBe(now.toISOString());
    // Due, because a locked job is claimable as soon as a process exists.
    expect(await sweep()).toEqual([SLUG]);
  });

  test("a job whose lock is long stale is due too", async () => {
    // The lost-step case: the container died mid-step. Dated from the lock either
    // way now, so this no longer distinguishes itself from the case above by
    // DUENESS — it is kept because the hint must still be the lock's time rather
    // than the far-past `run_at`, which is what the platform's own backoff reads.
    const stale = new Date(Date.now() - 5 * 3_600_000);
    await addJob({ runAt: PAST, lockedAt: stale.toISOString() });
    await publish();

    expect(await storedHint()).toBe(stale.toISOString());
    expect(await sweep()).toEqual([SLUG]);
  });

  test("an empty queue publishes null, which is what stops the waking", async () => {
    await addJob({ runAt: PAST });
    await publish();
    expect(await sweep()).toEqual([SLUG]);

    await guest.query("delete from graphile_worker.jobs");
    await publish();

    // Null rather than a deleted row: an absent row and "nothing pending" would
    // otherwise be indistinguishable to the platform.
    expect(await storedHint()).toBeNull();
    expect(await sweep()).toEqual([]);
  });

  test("no queue in the database means no hint table at all", async () => {
    // The Local World under `aai dev`, or a world that failed to start.
    await guest.query("alter schema graphile_worker rename to graphile_worker_hidden");
    try {
      await publish();
      expect(await storedHint()).toBeUndefined();
      expect(await sweep()).toEqual([]);
    } finally {
      await guest.query("alter schema graphile_worker_hidden rename to graphile_worker");
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
    const other = createPostgresDb({ url: urlFor(otherName), max: 1 });
    await other.query(`create table ${APP_DB_SCHEMA}.${WORKFLOW_WAKE_TABLE} (nothing_useful int)`);
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
    await publish();

    const rows = await guest.query<{ count: string }>(
      `select count(*) as count from ${APP_DB_SCHEMA}.${WORKFLOW_WAKE_TABLE}`,
    );
    // One row, whatever happens: the table's primary key admits only `true`.
    expect(Number(rows[0]?.count)).toBe(1);
  });

  test("the one-row invariant is enforced by the table, not by the writer", async () => {
    await publish();
    // The SQLSTATE, not a bare `rejects.toThrow()`: any rejection satisfies
    // that — a renamed column, a schema that does not exist, a typo in the
    // statement — so the claim would survive the `check (id)` being dropped.
    // 23514 is check_violation, which is the constraint under test.
    await expect(
      guest.query(
        `insert into ${APP_DB_SCHEMA}.${WORKFLOW_WAKE_TABLE} (id, wake_at) values (false, now())`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
