// Copyright 2026 the AAI authors. MIT license.
/**
 * Is a workflow run really durable? — against a REAL Postgres journal.
 *
 * The property and the harness are shared with the fast tier
 * (`host/workflow-restart.test.ts`, `host/_workflow-restart-harness.ts`); what
 * this tier adds is the one thing that tier cannot have. The memory store holds
 * JS values, so it models the journal's API faithfully and its ENCODING not at
 * all — the same blind spot `aai-server/jsonb-encoding.integration.test.ts` exists
 * for, and the reason `workflow-store.ts` carries a long note about
 * `::text::jsonb`. A step output that survives a restart in the fake can come back
 * DOUBLE-ENCODED from Postgres, and replay would then hand the resumed run a
 * string where it wrote an object. That failure is invisible above this line, and
 * it is the failure a durability claim most needs to exclude: the run completes,
 * reports success, and its resumed half read garbage.
 *
 * Each step's journaled value is therefore an object with a NUMBER in it, read
 * back numerically by the workflow itself — so a bad round trip fails inside the
 * run rather than as a cosmetic difference in an assertion here.
 *
 * **Each restart takes a NEW connection pool as well as a new engine**, which is
 * the other half of what a restarted process does not keep. The fast tier shares
 * one stub `Db` across engines — correct there, and it would quietly weaken the
 * claim here.
 *
 * Self-cleaning: it drops the three journal tables it created. Point it at a
 * scratch database, never production — `init()` creates tables in whatever schema
 * the URL's `search_path` resolves to.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres@127.0.0.1:55432/postgres' \
 *   pnpm --filter @alexkroman1/aai test:integration
 * ```
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_test-utils.ts";
import {
  type BootedHost,
  createRestartProbe,
  RESTART_EXPECTED_OUTPUT,
  RESTART_STEPS,
  stepThroughRestarts,
} from "../_workflow-restart-harness.ts";
import { asStatus } from "../_workflow-test-utils.ts";
import { type CloseableDb, createPostgresDb } from "../postgres-db.ts";
import { createWorkflowEngine } from "../workflow-engine.ts";
import { createPostgresWorkflowStore } from "../workflow-store.ts";

const PG_URL = process.env.AAI_TEST_PG_URL;

// Skipped without a database rather than failing: the unit tier has no Postgres,
// and this suite is selected by the integration profile.
const describeWithPg = PG_URL ? describe : describe.skip;

const JOURNAL_TABLES = ["aai_workflow_steps", "aai_workflow_runs", "aai_workflow_blobs"] as const;

/** A pool, plus the store over it — what one booted host holds. */
function openHostDb(): { db: CloseableDb; store: ReturnType<typeof createPostgresWorkflowStore> } {
  // Non-null: only reached inside `describeWithPg`, which requires the URL.
  const db = createPostgresDb({ url: PG_URL as string, max: 2 });
  return { db, store: createPostgresWorkflowStore(db) };
}

/** Drop the journal, so a previous run's rows can never make this one pass. */
async function dropJournal(db: CloseableDb): Promise<void> {
  // Children first — `aai_workflow_steps` has a foreign key into the runs table.
  for (const table of JOURNAL_TABLES) await db.query(`drop table if exists ${table}`);
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  await vi.waitFor(async () => {
    if (!(await check())) throw new Error("condition not met yet");
  });
}

describeWithPg("a workflow run survives a real host restart after every step", () => {
  beforeAll(async () => {
    const { db } = openHostDb();
    try {
      await dropJournal(db);
    } finally {
      await db.close();
    }
  });

  afterAll(async () => {
    const { db } = openHostDb();
    try {
      await dropJournal(db);
    } finally {
      await db.close();
    }
  });

  test(`journals through ${RESTART_STEPS} restarts, each step body running once`, async () => {
    const probe = createRestartProbe();
    // Built INSIDE the test: Biome's `noMisplacedAssertion` reads an `expect` in a
    // module-scope helper as a stray assertion, and it is right to — the adapter
    // only means anything for the duration of a test.
    const assertions = {
      waitFor,
      equal(actual: unknown, expected: unknown, label: string): void {
        expect(actual, label).toEqual(expected);
      },
    };

    /**
     * Boot a host: a fresh pool, a fresh store over it, a fresh engine over that.
     *
     * `expireLease` is a direct UPDATE on the database's own clock rather than a
     * wait — see `BootedHost.expireLease`. It is the one thing this test does to
     * the journal that the engine would not.
     */
    const boot = (): Promise<BootedHost> => {
      const { db, store } = openHostDb();
      return Promise.resolve({
        store,
        engine: createWorkflowEngine({
          workflows: probe.workflows,
          store,
          db,
          env: {},
          generate: undefined,
          logger: silentLogger,
        }),
        async expireLease(runId: string): Promise<void> {
          await db.query(
            "update aai_workflow_runs set lease_until = now() - interval '1 second' where run_id = $1",
            [runId],
          );
        },
        shutdown: () => db.close(),
      });
    };

    const { runId, host } = await stepThroughRestarts(probe, boot, assertions);
    try {
      // Read through the LAST host's pool, which is the only one still open — the
      // point being that the run's whole state is in the database, reachable by a
      // process that saw none of the earlier steps happen.
      const finished = asStatus(await host.store.get(runId), "completed");
      expect(finished.output).toEqual(RESTART_EXPECTED_OUTPUT);
      expect(finished.stepsCompleted).toBe(RESTART_STEPS);
      expect(probe.bodyRuns).toEqual(Array.from({ length: RESTART_STEPS }, () => 1));

      // Every journaled output is still an OBJECT, not a JSON string of one. This
      // is the assertion the fake cannot make, and the one that would have caught
      // the double-encoding bug.
      const journal = await host.store.completedSteps(runId);
      expect([...journal.keys()]).toEqual(
        Array.from({ length: RESTART_STEPS }, (_unused, i) => `s:step-${i}#0`),
      );
      expect([...journal.values()]).toEqual(
        Array.from({ length: RESTART_STEPS }, (_unused, i) => ({ index: i, doubled: i * 2 })),
      );
    } finally {
      host.engine.close();
      await host.shutdown();
    }
  });
});
