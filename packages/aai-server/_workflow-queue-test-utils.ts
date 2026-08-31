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
 * **Each suite passes its OWN slugs.** The two files run in the same tier against
 * the same database, and `beforeEach` deletes this fixture's rows by slug — so
 * sharing a tenant would let one suite truncate the other's table mid-test. The
 * `afterAll` deletes exactly the agents it created, which cascades to their
 * messages: the FK does the cleanup rather than a second delete that could drift
 * from it.
 *
 * **A scenario test may own its ROWS; it may not own the SCHEMA.** The tables come
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
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { pgUrl } from "./_pg-test-utils.ts";
import type { HonoEnv } from "./context.ts";
import { slugMw } from "./middleware.ts";
import type { AdminDb } from "./platform-lock.ts";
import type { SqlExec } from "./secret-store.ts";
import { createTestStore, ensurePlatformTables, type TestFetch } from "./test-utils.ts";
import { createWorkflowEnqueueHandler } from "./workflow-enqueue-handler.ts";
import type { EnqueueParams } from "./workflow-queue-store.ts";

/**
 * What a queue suite reads out of the fixture.
 *
 * Every field is a GETTER rather than a value: the fixture's `beforeAll` has not
 * run when the suite body registers its tests, so a plain value would be captured
 * as `undefined` for the whole file.
 */
export type QueueFixture = {
  sql: () => SqlExec;
  /** The same database as {@link QueueFixture.sql}, as the reserving handle a pass needs. */
  adminDb: () => AdminDb;
  /**
   * A real platform over that same database, so a test can go through the HTTP
   * route rather than calling `enqueue` directly. The agents live in Postgres;
   * only the BUNDLE store is in memory, which neither suite reads.
   */
  platformFetch: () => TestFetch;
  /** One ORCHESTRATION message for `runId`, on this fixture's first tenant. */
  msg: (id: string, runId: string, over?: Partial<EnqueueParams>) => EnqueueParams;
};

/**
 * Register the hooks and answer the accessors. Call it inside a `describeWithPg`
 * body, never at module scope — the hooks belong to the suite that asks for them.
 */
export function useQueueFixture(slugs: readonly string[]): QueueFixture {
  let close: (() => Promise<void>) | undefined;
  let sql: SqlExec;
  let adminDb: () => AdminDb;
  let platformFetch: TestFetch;

  /**
   * The columns the shipped `agents` table really requires — every NOT NULL
   * without a default. Listed rather than derived, so a new required column fails
   * HERE, loudly, instead of these suites silently testing a table shape the
   * migration does not have.
   */
  const seedAgent = (slug: string) =>
    sql(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
      [slug],
    );

  beforeAll(async () => {
    // `pgUrl()` inside the hook: vitest executes a skipped `describe` body to
    // enumerate it, so reading at the top would throw on a machine with no PG.
    const db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (q, p) => db.query(q, p);
    adminDb = () => ({ reserve: () => db.reserve(), listen: (c, f) => db.listen(c, f) });
    close = () => db.close();

    await ensurePlatformTables(sql);
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
    app.post("/:slug/workflow-enqueue", slugMw, createWorkflowEnqueueHandler(adminDb()));
    // `app.request` is sync-or-async depending on the route; `TestFetch` is the
    // async half, which is what every caller awaits anyway.
    platformFetch = async (input, init) => app.request(input, init);
  });

  afterAll(async () => {
    for (const slug of slugs) {
      await sql("delete from aai_platform.agents where slug = $1", [slug]).catch(() => undefined);
    }
    await close?.();
  });

  beforeEach(async () => {
    await sql("delete from aai_platform.workflow_queue where slug = any($1::text[])", [slugs]);
  });

  return {
    sql: () => sql,
    adminDb: () => adminDb(),
    platformFetch: () => platformFetch,
    msg: (id, runId, over = {}) => ({
      id,
      slug: slugs[0] as string,
      queueName: `__wkf_workflow_${runId}`,
      payload: { runId },
      ...over,
    }),
  };
}
