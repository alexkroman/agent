// Copyright 2026 the AAI authors. MIT license.
/**
 * The shared fixture for the two real-Postgres queue suites.
 *
 * It exists because `workflow-queue-store.scenario.test.ts` hit the 700-line test
 * cap and split along the same seam its source did: one message's own lifecycle
 * (`workflow-queue-store.scenario.test.ts`) against the DELIVERY CLAIM
 * (`workflow-queue-claim.scenario.test.ts`). Both need the same ~100 lines of
 * setup — a real database, the platform tables, seeded tenants, and the enqueue
 * route mounted over that same database — and duplicating it would mean two
 * copies of every argument recorded below, drifting.
 *
 * **Each suite gets its OWN DATABASE**, which replaced per-suite SLUGS — see
 * {@link useThrowawayPlatformDb} for the two measured flakes that forced it. The
 * short version is that slugs isolate the rows a test writes and nothing about
 * the fleet-wide predicates that read them, and every predicate here is
 * fleet-wide. `beforeEach` can therefore delete the whole table, and cleanup is
 * a `drop database` rather than a per-slug delete that has to stay in step with
 * what the tests wrote.
 *
 * **A scenario test may own its ROWS and now its DATABASE; it may not own the
 * SCHEMA.** The tables come
 * from `ensurePlatformTables`, never from a `create table if not exists` here —
 * that was tried, and it was worse than useless: it invented a shape the migration
 * might not have, and a matching `drop` in `afterAll` destroyed the real table for
 * every later suite (`realtime-rls.scenario.test.ts` reported it missing). The
 * helper also verifies a CLI-built stack against its ledger and otherwise applies
 * the migrations, which is what makes these suites run on BOTH arms: a plain
 * Postgres (CI's `AAI_TEST_PG_URL` is the runner's own cluster) and the local
 * Supabase stack. An earlier draft asserted the table was already there, which
 * passed locally against a migrated stack and failed every CI run.
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { createPlatformQueueSend } from "@alexkroman1/aai-runtime/internal";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { pgUrl } from "./_pg-test-utils.ts";
import type { HonoEnv } from "./context.ts";
import { guestTokenFor } from "./guest-token.ts";
import { slugMw } from "./middleware.ts";
import type { AdminDb } from "./platform-lock.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import type { SqlExec } from "./secret-store.ts";
import { createTestStore, ensurePlatformTables, type TestFetch } from "./test-utils.ts";
import { createWorkflowEnqueueHandler } from "./workflow-enqueue-handler.ts";
import { type EnqueueParams, WORKFLOW_QUEUE_CHANNEL } from "./workflow-queue-store.ts";

/** What {@link withQueueNotifications} lends a test body. */
export type QueueNotifyProbe = {
  /** `WORKFLOW_QUEUE_CHANNEL` notifications delivered so far. */
  count: () => number;
  /**
   * Commit a sentinel on the same connection the writes use, and wait for it.
   *
   * This is what makes an ABSENCE assertable. The obvious version — write, then
   * `vi.waitFor(() => expect(count()).toBe(1))` — PASSES when the code is wrong,
   * verified by making the notify unconditional: `waitFor` polls until the
   * assertion holds, and with both writes notifying it holds transiently after
   * the first arrives and before the second does. Postgres delivers
   * notifications to one connection in COMMIT order, so a sentinel committed
   * after the write arrives after anything that write would have sent: once this
   * resolves, "no queue notification yet" is a settled fact rather than a race.
   * A `sleep()` is the alternative and is both slower and weaker.
   */
  fence: () => Promise<void>;
};

/**
 * Count queue notifications on this fixture's OWN database while `body` runs.
 *
 * The database matters: `WORKFLOW_QUEUE_CHANNEL` carries every tenant's enqueue,
 * so a listener built from `pgUrl()` would sit on the shared database while the
 * writes announce on this one — the positive controls fail and the absences pass
 * vacuously. See {@link useThrowawayPlatformDb}.
 */
export async function withQueueNotifications(
  fx: QueueFixture,
  body: (probe: QueueNotifyProbe) => Promise<void>,
): Promise<void> {
  const BARRIER = "aai_test_queue_barrier";
  let count = 0;
  let fenced = 0;
  const listener = createPostgresDb({ url: fx.url(), max: 2 });
  try {
    const stopQueue = await listener.listen(WORKFLOW_QUEUE_CHANNEL, () => {
      count += 1;
    });
    const stopBarrier = await listener.listen(BARRIER, () => {
      fenced += 1;
    });
    try {
      await body({
        count: () => count,
        fence: async () => {
          const want = fenced + 1;
          await fx.sql()("select pg_notify($1, '')", [BARRIER]);
          // THROWS rather than asserting, and that is the lint rule rather than a
          // preference: an `expect` outside a `test()` body is
          // `noMisplacedAssertion`, and `vi.waitFor` retries on a throw exactly
          // as it retries on a failed assertion. The assertions belong to the
          // caller either way — this only waits.
          await vi.waitFor(() => {
            if (fenced < want) throw new Error(`barrier ${want} not delivered yet`);
          });
        },
      });
    } finally {
      stopQueue();
      stopBarrier();
    }
  } finally {
    await listener.close();
  }
}

/**
 * Code-unit order, the repo's standing rule for anything an assertion reads —
 * `localeCompare` with no explicit locale answers to the runtime's ICU default,
 * so the same rows would sort differently on another machine.
 */
export const byCodeUnit = (a: string, b: string) => Number(a > b) - Number(a < b);

/**
 * A private, migrated platform database for one suite, torn down after it.
 *
 * **Every queue predicate is FLEET-WIDE, which is what makes this necessary
 * rather than tidy.** `claimDue` takes due messages for any slug,
 * `WORKFLOW_QUEUE_CHANNEL` carries every tenant's enqueue, and
 * `findStalledRuns` scans every run in the database under an `order by
 * created_at` and a `limit`. So a per-suite SLUG isolates the rows a test
 * writes and nothing about the predicates that read them — and vitest runs
 * files in parallel.
 *
 * Both failures were measured on the real tier, and neither is theoretical:
 *
 * - Seeding ONE stalled run under a foreign slug fails four cases of
 *   `workflow-queue-store.scenario.test.ts` on its own, because `runQueuePass`
 *   reconciles that foreign run and every count in the suite then sees a row it
 *   did not write.
 * - `findStalledRuns`'s `limit` is fleet-wide too, so a suite's own run can be
 *   pushed out of the answer entirely by a sibling's older rows — which reads as
 *   `expected [] to deeply equal [ 'wrun_stalled' ]`, a predicate failure, in a
 *   suite that did nothing wrong.
 *
 * Full scenario runs alternated between green and one-to-seven failures across
 * these two files, never the same cases twice. A private database is the only
 * fix that matches the shape: scoping assertions by slug cannot work when the
 * fleet-wide predicate IS the subject, and a `beforeEach` cannot delete rows a
 * sibling has not written yet.
 *
 * The schema comes from `ensurePlatformTables`, never a `create table` here: it
 * replays the migrations' own statements, so the foreign keys, the cascades and
 * the unique idempotency index are the SHIPPED ones. A hand-written schema in a
 * private database would be a shape the migration might not have, which is the
 * trap `test-utils.ts` records.
 */
export function useThrowawayPlatformDb(label: string): {
  sql: () => SqlExec;
  url: () => string;
  adminDb: () => AdminDb;
} {
  let sql: SqlExec;
  let dbUrl: string;
  let adminDb: () => AdminDb;
  let close: (() => Promise<void>) | undefined;
  let adminUrl: string;
  let dbName: string;

  beforeAll(async () => {
    // `pgUrl()` inside the hook: vitest executes a skipped `describe` body to
    // enumerate it, so reading at the top would throw on a machine with no PG.
    adminUrl = pgUrl();
    // `create database` runs in no transaction and needs some OTHER database —
    // hence the two-step. The identifier is ours and matches [a-z0-9_].
    dbName = `aai_${label}_${process.pid}_${Math.trunc(performance.now())}`;
    const admin = createPostgresDb({ url: adminUrl, max: 1 });
    try {
      await admin.query(`create database ${dbName}`);
    } finally {
      await admin.close();
    }
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    // `URL` renders `postgres:` as `postgres://…`; keep the driver's spelling.
    dbUrl = url.toString();
    const db = createPostgresDb({ url: dbUrl, max: 4 });
    sql = (q, p) => db.query(q, p);
    adminDb = () => ({ reserve: () => db.reserve(), listen: (c, f) => db.listen(c, f) });
    close = () => db.close();
    await ensurePlatformTables(sql);
  });

  afterAll(async () => {
    await close?.();
    const admin = createPostgresDb({ url: adminUrl, max: 1 });
    try {
      await admin.query(`drop database if exists ${dbName}`);
    } finally {
      await admin.close();
    }
  });

  return { sql: () => sql, url: () => dbUrl, adminDb: () => adminDb() };
}

/**
 * What a queue suite reads out of the fixture.
 *
 * Every field is a GETTER rather than a value: the fixture's `beforeAll` has not
 * run when the suite body registers its tests, so a plain value would be captured
 * as `undefined` for the whole file.
 */
export type QueueFixture = {
  sql: () => SqlExec;
  /**
   * The fixture's OWN database URL.
   *
   * Exposed because the NOTIFY cases open a second connection to listen on, and
   * a listener built from `pgUrl()` would sit on the shared database while
   * `enqueue` announces on this one — so the notification never arrives and the
   * positive control fails. A private channel is most of what the isolation
   * buys: `WORKFLOW_QUEUE_CHANNEL` carries every tenant's enqueue, so the
   * "a DELAYED message does not notify" count was previously incrementable by
   * any sibling suite.
   */
  url: () => string;
  /** The same database as {@link QueueFixture.sql}, as the reserving handle a pass needs. */
  adminDb: () => AdminDb;
  /**
   * A real platform over that same database, so a test can go through the HTTP
   * route rather than calling `enqueue` directly. The agents live in Postgres;
   * only the BUNDLE store is in memory, which neither suite reads.
   */
  platformFetch: () => TestFetch;
  /**
   * The GUEST's own enqueue client, dialling {@link QueueFixture.platformFetch}
   * as the first tenant — the whole outbound wire, from `createPlatformQueueSend`
   * through the bearer to the real route and the real store.
   *
   * Here rather than in the suite because three cases need it and the wiring is
   * twenty lines of bearer-plus-fetch adapter apiece: the enqueue-to-delivery
   * loop, the run key SQL reads back out of the envelope, and the `kind` the
   * store derives from the queue name. Two hand-rolled copies were already in
   * the file and it is at the 700-line test cap, which its own doc says to
   * answer by extracting more SETUP rather than by splitting the subject.
   */
  guestSend: () => ReturnType<typeof createPlatformQueueSend>;
  /** One ORCHESTRATION message for `runId`, on this fixture's first tenant. */
  msg: (id: string, runId: string, over?: Partial<EnqueueParams>) => EnqueueParams;
};

/**
 * Register the hooks and answer the accessors. Call it inside a `describeWithPg`
 * body, never at module scope — the hooks belong to the suite that asks for them.
 */
export function useQueueFixture(slugs: readonly string[]): QueueFixture {
  // The private database — see {@link useThrowawayPlatformDb} for why every
  // suite over this surface needs one. Registered FIRST, so its `beforeAll`
  // (create + migrate) runs before the agent seeding below.
  const db = useThrowawayPlatformDb("queue_fixture");
  let platformFetch: TestFetch;

  /**
   * The columns the shipped `agents` table really requires — every NOT NULL
   * without a default. Listed rather than derived, so a new required column fails
   * HERE, loudly, instead of these suites silently testing a table shape the
   * migration does not have.
   */
  const seedAgent = (slug: string) =>
    db.sql()(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
      [slug],
    );

  beforeAll(async () => {
    for (const slug of slugs) await seedAgent(slug);

    // JUST the enqueue route over that same database — deliberately NOT
    // `createTestOrchestrator`.
    //
    // A full orchestrator starts this surface's background sweeps and keeps no
    // handle to stop them (`agent-sweeps.ts`), so with a real `adminDb` a suite
    // left a 1-SECOND queue sweep running against the shared scenario database
    // after it finished. That is exactly what it did on the first run: every test
    // passed and `workflow-world.scenario.test.ts` failed beside it, which is the
    // most expensive shape of test failure available — a suite breaking a sibling.
    //
    // The route needs a store for its `getAgentVersion` check and a slug from the
    // path, and nothing else, so that is all this mounts.
    const store = createTestStore();
    await store.putAgent({
      slug: slugs[0] as string,
      env: {},
      worker:
        'export default { name: "a", systemPrompt: "p", greeting: "", maxSteps: 1, tools: {} };',
      clientFiles: {},
      credential_hashes: [],
    });
    const app = new Hono<HonoEnv>();
    app.use("*", async (c, next) => {
      c.env = { store } as HonoEnv["Bindings"];
      await next();
    });
    app.post("/:slug/workflow-enqueue", slugMw, createWorkflowEnqueueHandler(db.adminDb()));
    // `app.request` is sync-or-async depending on the route; `TestFetch` is the
    // async half, which is what every caller awaits anyway.
    platformFetch = async (input, init) => app.request(input, init);
  });

  beforeEach(async () => {
    // EVERY row, not just this fixture's slugs. The database is the suite's own,
    // so anything here is something one of its own cases wrote — and a reconcile
    // pass writes rows under whatever slug it repaired, which a `slugs` filter
    // would miss.
    await db.sql()("delete from aai_platform.workflow_queue");
    await db.sql()("delete from aai_platform.workflow_runs");
  });

  return {
    sql: () => db.sql(),
    url: () => db.url(),
    adminDb: () => db.adminDb(),
    platformFetch: () => platformFetch,
    guestSend: () =>
      createPlatformQueueSend({
        base: `http://platform.test/${slugs[0]}`,
        // `AAI_GUEST_TOKEN_SECRET` is unset in these suites, so `guestTokenFor`
        // draws a per-process key — which both sides read, so they agree.
        token: guestTokenFor(agentSandboxName(slugs[0] as string, 1)),
        fetch: async (input, init) => {
          const req = new Request(input, init);
          return platformFetch(new URL(req.url).pathname, {
            method: req.method,
            headers: req.headers,
            body: await req.text(),
          });
        },
      }),
    msg: (id, runId, over = {}) => ({
      id,
      slug: slugs[0] as string,
      queueName: `__wkf_workflow_${runId}`,
      payload: { runId },
      ...over,
    }),
  };
}
