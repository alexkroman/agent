// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow-keys contract's SECOND arm: `createPostgresKeyStore`, over a real
 * server.
 *
 * The unit arm (`workflow-keys-conformance.test.ts`) runs the same case list
 * against a `Map`. It cannot answer the half of this contract that is a claim
 * about a DATABASE, and that half is where every property worth having lives:
 *
 * - `on conflict (run_id) do nothing` is a no-op only if the primary key really
 *   IS on `run_id` — a statement recorder replays the text and cannot know — and
 *   that clause is the whole of this contract's idempotency, which is where BOTH
 *   of the drifts this table found lived;
 * - `order by created_at desc, run_id desc` is what makes "newest first" true,
 *   and `created_at` is `now()`, i.e. the statement's own transaction time
 *   rather than a value this process chose;
 * - `limit $3` is a bind parameter Postgres resolves to `bigint`, which is a
 *   driver question;
 * - and the table has to EXIST, which means the lazy DDL has to have run — twice
 *   over, since `ensureOnce` memoizes per STORE and this suite builds one.
 *
 * `aai-server/workflow-keys.scenario.test.ts` already drives this store against
 * a real Postgres and stays: it asserts the DDL's own output (exactly one table,
 * its name derived from the schema rather than from a constant), the four-column
 * index definition, a FORCED same-millisecond ULID tiebreak, and the lookup a
 * second time with index scans disabled so `, run_id desc` is exercised on a
 * plan that has to SORT. Those are claims about the SCHEMA and the PLAN. This
 * file is the parity arm — the same cases the memory store answers, answered by
 * the database — and neither replaces the other.
 *
 * **What even this arm cannot see** is durability across a process, which is the
 * one property the two arms must NOT agree on (the memory store is deliberately
 * not durable), and anything concurrent: the cases record serially, because
 * `created_at` is a transaction timestamp and a parallel insert would leave the
 * ordering contract up to the pool.
 *
 * Self-cleaning: one schema, created and dropped by this file.
 *
 * ```sh
 * pnpm test:pg pnpm --filter @alexkroman1/aai-runtime test:scenario
 * ```
 */

import { afterAll, beforeAll } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { createPostgresDb } from "./postgres-db.ts";
import type { WorkflowKeyStore } from "./workflow-keys.ts";
import { createPostgresKeyStore } from "./workflow-keys.ts";
import { workflowKeyConformance, workflowKeyIds } from "./workflow-keys-conformance.ts";

/**
 * NOT app-shaped (`app_` + 16 hex): the platform's TTL sweep walks every
 * app-shaped schema and this file's table is none of its business. Distinct from
 * every other scenario suite's schema — `aai-server`'s own key-store suite uses
 * `wf_keys_scenario` — so the tier can run its files in one process.
 */
const SCHEMA = "wf_keys_conformance";

describeWithPg("the workflow-keys contract over a real Postgres", () => {
  let admin: ReturnType<typeof createPostgresDb>;
  /** A handle whose `search_path` is the test schema, as a guest's own role is. */
  let appDb: ReturnType<typeof createPostgresDb>;
  let store: WorkflowKeyStore;

  beforeAll(async () => {
    // `pgUrl()` inside the hook and never at the top of this body: vitest
    // EXECUTES a skipped describe's callback to enumerate what it is skipping,
    // so a read up there fails the file instead of skipping it.
    admin = createPostgresDb({ url: pgUrl() });
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.query(`create schema ${SCHEMA}`);
    // `search_path` rather than qualified names: the store's SQL is unqualified,
    // so this is how a self-hosted `DATABASE_URL` really reaches it, and it is
    // how the platform provisions an app role. The DDL is NOT applied here —
    // the store creates its own table lazily on first use, which is the design
    // (an agent's first workflow may be its first ever deploy, so there is no
    // provisioning pass to hang a migration off) and therefore part of what this
    // arm exercises.
    appDb = createPostgresDb({ url: `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}` });
    store = createPostgresKeyStore(appDb);
  });

  afterAll(async () => {
    await appDb?.close();
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.close();
  });

  // ONE store across every case — a scenario arm cannot afford a database per
  // test — which is exactly why every case mints its workflow name and its run
  // ids from `uid()`.
  workflowKeyConformance({
    label: "postgres",
    keys: () => store,
    uid: workflowKeyIds("pg"),
  });
});
