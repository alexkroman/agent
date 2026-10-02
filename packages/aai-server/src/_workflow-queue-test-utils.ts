// Copyright 2026 the AAI authors. MIT license.
/**
 * The shared fixture for the real-Postgres queue suites
 * (`workflow-queue-store` and `workflow-queue-claim`): a real database, the
 * platform tables, seeded tenants, and the enqueue route mounted over it.
 *
 * - **Each suite gets its OWN DATABASE** ({@link useThrowawayPlatformDb}):
 *   every queue predicate is fleet-wide, so slugs cannot isolate them.
 * - **A suite may own its rows and its database, never the SCHEMA**: tables
 *   come from `ensurePlatformTables`, never a hand-written `create table`, so
 *   the fixture has the shipped shape on both arms (a plain Postgres and the
 *   Supabase stack).
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { createPlatformQueueSend } from "@alexkroman1/aai-runtime/internal";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, onTestFinished, vi } from "vitest";
import { createTestStore, type TestFetch } from "./_orchestrator-test-utils.ts";
import { pgUrl } from "./_pg-test-utils.ts";

import type { HonoEnv } from "./context.ts";
import { guestTokenFor } from "./guest/token.ts";
import { createWorkflowEnqueueHandler } from "./guest-handlers/workflow-enqueue.ts";
import { slugMw } from "./middleware.ts";
import { ensurePlatformTables } from "./platform/_schema-test-utils.ts";
import type { AdminDb } from "./platform/lock.ts";
import { agentSandboxName } from "./sandbox/directory.ts";
import type { SqlExec } from "./sql-exec.ts";
import { type EnqueueParams, WORKFLOW_QUEUE_CHANNEL } from "./workflow-queue-store.ts";

/** What {@link listenForQueueNotifications} hands a test. */
export type QueueNotifyProbe = {
  /** `WORKFLOW_QUEUE_CHANNEL` notifications delivered so far. */
  count: () => number;
  /**
   * Commit a sentinel on the same connection the writes use, and wait for it.
   *
   * This is what makes an ABSENCE assertable: Postgres delivers one
   * connection's notifications in COMMIT order, so once the sentinel arrives,
   * "no queue notification yet" is settled. A `vi.waitFor` on the count passes
   * when the code is wrong (it holds transiently between two notifications),
   * and a `sleep()` is slower and weaker.
   */
  fence: () => Promise<void>;
};

/**
 * Count queue notifications on this fixture's OWN database for the rest of the
 * calling test; the listener closes when the test finishes.
 *
 * The database matters: `WORKFLOW_QUEUE_CHANNEL` carries every tenant's enqueue,
 * so a listener built from `pgUrl()` would sit on the shared database while the
 * writes announce on this one — the positive controls fail and the absences pass
 * vacuously. See {@link useThrowawayPlatformDb}.
 */
export async function listenForQueueNotifications(fx: QueueFixture): Promise<QueueNotifyProbe> {
  const BARRIER = "aai_test_queue_barrier";
  let count = 0;
  let fenced = 0;
  const listener = createPostgresDb({ url: fx.url(), max: 2 });
  const stops: (() => void)[] = [];
  // ONE callback, registered before any `listen`: unlisten, THEN close the
  // pool, and still close it when a `listen` below throws.
  onTestFinished(async () => {
    for (const stop of stops) stop();
    await listener.close();
  });
  stops.push(
    await listener.listen(WORKFLOW_QUEUE_CHANNEL, () => {
      count += 1;
    }),
  );
  stops.push(
    await listener.listen(BARRIER, () => {
      fenced += 1;
    }),
  );
  return {
    count: () => count,
    fence: async () => {
      const want = fenced + 1;
      await fx.sql()("select pg_notify($1, '')", [BARRIER]);
      await vi.waitUntil(() => fenced >= want);
    },
  };
}

/**
 * A private, migrated platform database for one suite, torn down after it.
 *
 * Necessary because every queue predicate is FLEET-WIDE — `claimDue` takes any
 * slug's due messages, `WORKFLOW_QUEUE_CHANNEL` carries every tenant's enqueue,
 * and `findStalledRuns` scans (and `limit`s) every run — while vitest runs files
 * in parallel. Per-suite slugs isolate the rows a test writes, not the
 * predicates that read them: a sibling's rows change counts and can push a
 * suite's own run out of a `limit`ed answer.
 *
 * The schema comes from `ensurePlatformTables` (the migrations' own
 * statements), so foreign keys, cascades and the unique idempotency index are
 * the shipped ones.
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
 * What a queue suite reads out of the fixture. Every field is a GETTER: the
 * fixture's `beforeAll` has not run when the suite body registers its tests.
 */
export type QueueFixture = {
  sql: () => SqlExec;
  /**
   * The fixture's OWN database URL — what a NOTIFY listener must dial: one
   * built from `pgUrl()` sits on the shared database and never hears this one.
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

    // JUST the enqueue route over that same database — never
    // `createTestOrchestrator`, which starts background sweeps it keeps no
    // handle to stop, so a 1-second queue sweep would outlive the suite and
    // break siblings. The route needs a store (for `getAgentVersion`) and a
    // slug from the path, and nothing else.
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
