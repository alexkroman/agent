// Copyright 2026 the AAI authors. MIT license.
/**
 * The self-hosted door PROVISIONS its own tables, over a real Postgres.
 *
 * `createAgentServer` is what the self-hosting page documents and what
 * `examples/self-hosted-server` runs, and a `DATABASE_URL` puts BOTH of this
 * runtime's durable stores in that database — session state
 * (`runtime-session-state.ts`) and the durable-run journal (`selectJournal`).
 * The tables come with whoever OWNS the database, and a self-hosted deployment
 * has no migration step anywhere to hang them off, so the door has to apply the
 * DDL itself. It did not: both `ensure*Schema` functions are PUBLIC precisely so
 * a self-hoster can reach them, and their only production callers were
 * `aai-cli`'s `npm start` and `aai dev` — the two doors that are not this one.
 *
 * So a self-hosted agent with a database got a boot line reading
 * `sessionState: postgres, durable: true` and `runStore: "postgres"`, and then
 * the first session died with `relation "aai_session_events" does not exist`
 * and the first run with `42P01 relation "aai_workflow_runs" does not exist`.
 * `workflow-journal-schema.ts` records that as already-shipped, in the words
 * this suite exists to keep true: **the boot line said durable and nothing
 * was.**
 *
 * ## Why this needs a real database, and what none of the neighbours can say
 *
 * The claim is that seven tables EXIST after `listen()` resolves, which is a
 * claim about a catalog. `workflow-journal-schema.test.ts` and
 * `session-state-postgres.test.ts` assert the statement LIST and the
 * warn-rather-than-throw posture against a `Db` double — right for the
 * appliers, and blind to a door that calls neither. `agent-server.test.ts`
 * covers the door and has no database. The gap was between them, and it is the
 * whole of what shipped.
 *
 * `self-hosted-restart.scenario.test.ts` is the nearest neighbour and is still
 * not this: it boots the same door against the same kind of database and calls
 * `ensureSessionStateSchema` in its own `beforeAll`, i.e. it provides by hand
 * exactly the thing under test here. Its `beforeAll` deliberately stays — a
 * suite about conversation durability should not silently depend on this fix —
 * so the two remain independent.
 *
 * ## Its own schema, like every other pg suite here
 *
 * The DDL is unqualified, which is how a self-hosted `DATABASE_URL` really
 * reaches it, so the `search_path` rides on the URL the door is handed. That
 * keeps the tier runnable in one process:
 * `self-hosted-restart.scenario.test.ts` creates these same table NAMES in
 * `public`, and a suite that dropped one there would be dropping another's.
 *
 * ```sh
 * pnpm test:pg pnpm --filter @alexkroman1/aai-runtime test:scenario
 * ```
 */

import { agent } from "@alexkroman1/aai";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { silentLogger } from "./_test-utils.ts";
import { createAgentServer } from "./agent-server.ts";
import { createPostgresDb } from "./postgres-db.ts";
import type { AgentServer } from "./server.ts";
import { SESSION_EVENT_TABLE, SESSION_STATE_TABLE } from "./session-state-postgres.ts";
import {
  WORKFLOW_ATTEMPT_TABLE,
  WORKFLOW_HOOK_TABLE,
  WORKFLOW_RUN_TABLE,
  WORKFLOW_SLEEP_TABLE,
  WORKFLOW_STEP_TABLE,
} from "./workflow-journal-schema.ts";

/**
 * NOT app-shaped (`app_` + 16 hex): the platform's TTL sweep walks every
 * app-shaped schema and this file's tables are none of its business. Distinct
 * from every other scenario suite's schema so the tier can run its files in one
 * process.
 */
const SCHEMA = "self_hosted_schema";

/** Every table a `DATABASE_URL`-backed deployment of this door needs. */
const OWED_TABLES = [
  SESSION_STATE_TABLE,
  SESSION_EVENT_TABLE,
  WORKFLOW_RUN_TABLE,
  WORKFLOW_STEP_TABLE,
  WORKFLOW_ATTEMPT_TABLE,
  WORKFLOW_SLEEP_TABLE,
  WORKFLOW_HOOK_TABLE,
] as const;

describeWithPg("a self-hosted server provisions its own tables", () => {
  let admin: ReturnType<typeof createPostgresDb>;
  const running: AgentServer[] = [];

  beforeAll(async () => {
    // `pgUrl()` inside the hook and never at the top of this body: vitest
    // EXECUTES a skipped describe's callback to enumerate what it is skipping,
    // so a read up there fails the file instead of skipping it.
    admin = createPostgresDb({ url: pgUrl() });
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.query(`create schema ${SCHEMA}`);
  });

  afterEach(async () => {
    for (const server of running.splice(0)) await server.close();
  });

  afterAll(async () => {
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.close();
  });

  /** The `DATABASE_URL` a deployment would set, pinned to this suite's schema. */
  function databaseUrl(): string {
    return `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}`;
  }

  /** `select to_regclass(...)` for each owed table — present, or null. */
  async function present(): Promise<string[]> {
    const found: string[] = [];
    for (const table of OWED_TABLES) {
      const rows = await admin.query<{ oid: string | null }>(
        `select to_regclass('${SCHEMA}.${table}')::text as oid`,
      );
      if (rows[0]?.oid) found.push(table);
    }
    return found;
  }

  /** Boot the documented door exactly as `server.mjs` assembles it. */
  async function boot(): Promise<AgentServer> {
    const server = createAgentServer({
      // A workflow declared, so the journal this deployment owns is one it
      // really uses — `selectJournal` reports `postgres` for it either way, and
      // the tables are owed either way, but a door serving `/workflows/*` is
      // the deployment the 42P01 was reported from.
      agent: agent({ name: "Self-hosted probe", systemPrompt: "You are a probe." }),
      env: { ASSEMBLYAI_API_KEY: "not-dialled", DATABASE_URL: databaseUrl() },
      logger: silentLogger,
    });
    running.push(server);
    await server.listen(0);
    return server;
  }

  test("listen() creates both stores' tables, and does it once per process", async () => {
    // The catalog is empty: nothing has migrated this schema, which is the
    // state a self-hoster's fresh database is in.
    expect(await present()).toEqual([]);

    const first = await boot();
    // The claim, and the A/B: with the DDL removed from the door this is `[]`
    // and the port is nonetheless open and reporting itself durable.
    expect(await present()).toEqual([...OWED_TABLES]);
    // Bound BEFORE anything can reach a store — the ordering is why the await
    // sits in front of the bind rather than after it.
    expect(first.port).toBeGreaterThan(0);

    // And the GUARD, asserted the only way it is observable from outside: drop
    // a table and boot a SECOND server on the same URL. `aai dev` rebuilds its
    // server on every file save, so re-issuing the DDL per boot is the ordinary
    // path, not an edge case — the door remembers the URL it has provisioned
    // and issues nothing the second time.
    for (const server of running.splice(0)) await server.close();
    await admin.query(`drop table ${SCHEMA}.${WORKFLOW_RUN_TABLE}`);

    await boot();
    expect(await present()).not.toContain(WORKFLOW_RUN_TABLE);
  });
});
