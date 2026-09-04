// Copyright 2026 the AAI authors. MIT license.
/**
 * The journal contract's THIRD arm: `createPostgresJournal`, over a real server.
 *
 * The two unit arms (`journal-conformance.test.ts`) run the same case list
 * against a `Map` and against the platform client over a fake transport. Neither
 * can answer the half of this contract that is a claim about a DATABASE, and
 * that half is most of it:
 *
 * - `claimAttempt` really increments under two concurrent claims, rather than
 *   handing both the same number and letting a step exceed its ceiling;
 * - `setStatus`'s `where` really constrains, so its row count is an answer;
 * - `appendStep`'s and `claimSleep`'s `on conflict do nothing` rest on primary
 *   keys that EXIST — a recorder replays the text and cannot know;
 * - a hook token is unique across RUNS, which is an index and not a check in JS;
 * - `bigint` comes back as a STRING, so every timestamp would be a lexicographic
 *   comparison without `millis()`;
 * - and `::text::jsonb` is what stops the driver double-encoding the codec's
 *   output, which shipped once and only a real server found.
 *
 * `aai-server/workflow-journal.scenario.test.ts` already drives this backend
 * against a real Postgres and stays: it asserts the DDL and the statement-level
 * properties above one at a time, which is a different job from asserting the
 * shared contract. This file is the parity arm — the same cases the memory and
 * platform backends answer, answered by the database.
 *
 * Self-cleaning: one schema, created and dropped by this file.
 *
 * ```sh
 * pnpm test:pg pnpm --filter @alexkroman1/aai-runtime test:scenario
 * ```
 */

import { afterAll, beforeAll } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { journalConformance, journalIds } from "./journal-conformance.ts";
import { createPostgresDb } from "./postgres-db.ts";
import { createPostgresJournal } from "./workflow-journal-postgres.ts";
import { applyWorkflowJournalDdl } from "./workflow-journal-schema.ts";
import type { JournalStore } from "./workflow-journal-types.ts";

/**
 * NOT app-shaped (`app_` + 16 hex): the platform's TTL sweep walks every
 * app-shaped schema and this file's tables are none of its business. Distinct
 * from every other scenario suite's schema so the tier can run its files in one
 * process.
 */
const SCHEMA = "wf_journal_conformance";

/** Silent — this suite asserts behaviour, not lines. */
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describeWithPg("the journal contract over a real Postgres", () => {
  let admin: ReturnType<typeof createPostgresDb>;
  /** A handle whose `search_path` is the test schema, as a guest's own role is. */
  let appDb: ReturnType<typeof createPostgresDb>;
  let journal: JournalStore;

  beforeAll(async () => {
    // `pgUrl()` inside the hook and never at the top of this body: vitest
    // EXECUTES a skipped describe's callback to enumerate what it is skipping,
    // so a read up there fails the file instead of skipping it.
    admin = createPostgresDb({ url: pgUrl() });
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.query(`create schema ${SCHEMA}`);
    // `search_path` rather than qualified names: that is how the platform
    // provisions an app role, so the journal's unqualified SQL runs the way a
    // guest runs it.
    appDb = createPostgresDb({ url: `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}` });
    await applyWorkflowJournalDdl({ db: appDb, logger });
    journal = createPostgresJournal({ db: appDb });
  });

  afterAll(async () => {
    await appDb?.close();
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.close();
  });

  // ONE store across every case — a scenario arm cannot afford a database per
  // test — which is exactly why every case mints its keys from `uid()`.
  journalConformance({
    label: "postgres",
    journal: () => journal,
    uid: journalIds("pg"),
    // The self-hosted store declares `resumableRuns` — the boot sweep is what a
    // self-hosted deployment recovers a stranded run with, there being no
    // platform queue to reconcile it. Pinned in
    // `workflow-journal-postgres.test.ts`; asserted against the live store by
    // the declaration case in `journal-conformance-resume.ts`.
    resumable: true,
  });
});
