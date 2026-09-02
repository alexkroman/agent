// Copyright 2026 the AAI authors. MIT license.
/**
 * The session-state contract's THIRD arm: `createPostgresStateBackend`, over a
 * real server.
 *
 * The two unit arms (`session-state-conformance.test.ts`) run the same case list
 * against a `Map` and against the platform client over a fake transport.
 * Neither can answer the half of this contract that is a claim about a
 * DATABASE, and that half is where every shipped bug in it has lived:
 *
 * - `on conflict (session_id, event_index) do nothing` rests on a primary key
 *   that EXISTS — a statement recorder replays the text and cannot know — and it
 *   is what makes a retried flush idempotent rather than an error;
 * - `value jsonb` and `event jsonb` REFUSE what is not JSON at write time, the
 *   one check the process above them cannot fake, and they NORMALIZE what they
 *   accept, which is why the cases compare parsed values;
 * - `event_index` is a `bigint`, so it comes back as a STRING and a caller
 *   comparing it to a number silently never matches;
 * - `order by event_index` is what makes a sparse log readable in order;
 * - and `::text::jsonb` versus a bare cast is the double-encoding bug that
 *   shipped once in this repo and only a real server found.
 *
 * `aai-server/session-state.scenario.test.ts` already drives this backend
 * against a real Postgres and stays: it asserts the double-encode, the grants a
 * provisioned app role gets, and the store above the backend, one property at a
 * time. This file is the parity arm — the same cases the memory and platform
 * backends answer, answered by the database.
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
import { sessionStateConformance, sessionStateIds } from "./session-state-conformance.ts";
import { createPostgresStateBackend, sessionStateDdl } from "./session-state-postgres.ts";
import type { SessionStateBackend } from "./session-state-store.ts";

/**
 * NOT app-shaped (`app_` + 16 hex): the platform's TTL sweep walks every
 * app-shaped schema and this file's tables are none of its business. Distinct
 * from every other scenario suite's schema so the tier can run its files in one
 * process.
 */
const SCHEMA = "session_state_conformance";

describeWithPg("the session-state contract over a real Postgres", () => {
  let admin: ReturnType<typeof createPostgresDb>;
  /** A handle whose `search_path` is the test schema, as a guest's own role is. */
  let appDb: ReturnType<typeof createPostgresDb>;
  let backend: SessionStateBackend;

  beforeAll(async () => {
    // `pgUrl()` inside the hook and never at the top of this body: vitest
    // EXECUTES a skipped describe's callback to enumerate what it is skipping,
    // so a read up there fails the file instead of skipping it.
    admin = createPostgresDb({ url: pgUrl() });
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.query(`create schema ${SCHEMA}`);
    // `search_path` rather than qualified names: the backend's SQL is
    // unqualified, so this is how a self-hosted `DATABASE_URL` really reaches
    // it, and applying the SDK's OWN DDL rather than a copy is what keeps this
    // suite testing the shipped shape.
    appDb = createPostgresDb({ url: `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}` });
    for (const statement of sessionStateDdl()) await appDb.query(statement);
    backend = createPostgresStateBackend({ db: appDb });
  });

  afterAll(async () => {
    await appDb?.close();
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.close();
  });

  // ONE backend across every case — a scenario arm cannot afford a database per
  // test — which is exactly why every case mints its session id from `uid()`.
  sessionStateConformance({
    label: "postgres",
    backend: () => backend,
    uid: sessionStateIds("pg"),
  });
});
