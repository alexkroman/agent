// Copyright 2026 the AAI authors. MIT license.
/**
 * Does a per-app database really get created and dropped THROUGH the control
 * plane — SDK, HTTP, bearer, SQLSTATE and all?
 *
 * This is the suite the no-fallback decision owes. `create database` / `drop
 * database` have exactly one implementation (`app-db-admin.ts`) precisely so the
 * exercised path and the deployed path cannot differ — and that argument is only
 * worth anything if something exercises it. Every other spec for this channel
 * stubs `fetch` or injects the seam; here the statements leave over a real socket
 * as a real HTTP request, and land on a real Postgres.
 *
 * The far end is `dev-management-api.ts`, the same loopback stand-in
 * `pnpm dev:aai-server` runs — which is the second thing this pins: a developer's
 * local flow and this suite are the same collaborator, so the stand-in cannot
 * drift from what the platform sends without a test going red. In production the
 * far end is Supabase's own endpoint, and what it does with the statement is the
 * same thing this does: run it as `postgres`.
 *
 * What it CANNOT cover is Supabase's own behaviour — whether that endpoint wraps
 * a statement in a transaction (`25001`), how it rate-limits, what its 5xx looks
 * like. Those need the real thing, and `managementDatabaseAdmin` handles the one
 * of them that is not simply an error to report.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { PREVIEW_SLUG_SUFFIX } from "@alexkroman1/aai/internal";
import {
  createPostgresDb,
  SESSION_EVENT_TABLE,
  SESSION_STATE_TABLE,
} from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { createPgAgentRows } from "./agent-store.ts";
import {
  APP_DB_SCHEMA,
  type AppDbOpener,
  appDbIdentifier,
  createAppDatabases,
  deprovisionAppDatabase,
  provisionAppDatabase,
} from "./app-database.ts";
import { appDbAdmin, managementDatabaseAdmin } from "./app-db-admin.ts";
import { withDatabase } from "./app-db-url.ts";
import { createMemoryBlobStorage } from "./blob-storage.ts";
import { createBundleStore } from "./bundle-store.ts";
import { startDevManagementApi } from "./dev-management-api.ts";
import { createOrphanPreviewSweep } from "./orphan-previews.ts";
import { appDbSecretName, createMemorySecretStore, type SqlExec } from "./secret-store.ts";
import { createSupabaseManagementApi } from "./supabase-management.ts";
import { ensurePlatformTables } from "./test-utils.ts";
import { createPgWorkspaceStore } from "./workspace-store.ts";

/** A ref that names no real project, exactly as the dev stand-in uses. */
const REF = "localdevlocaldevloca";
const TOKEN = "scenario-throwaway-token";
const SLUG = "management-scenario-agent";
const APP_DB = appDbIdentifier(SLUG);

describeWithPg("provisioning through the Management API channel", () => {
  let url: string;
  let admin: ReturnType<typeof createPostgresDb>;
  let standIn: { url: string; close(): Promise<void> };
  let sql: SqlExec;
  let open: AppDbOpener;
  /** The real thing under test: an SDK client pointed at the stand-in. */
  let channel: ReturnType<typeof managementDatabaseAdmin>;
  /** The bound manager the reap deprovisions through. */
  let appDatabases: ReturnType<typeof createAppDatabases>;

  const databaseExists = async (): Promise<boolean> =>
    (await admin.query("select 1 from pg_database where datname = $1", [APP_DB])).length > 0;

  beforeAll(async () => {
    url = pgUrl();
    admin = createPostgresDb({ url, max: 4 });
    sql = (query, params) => admin.query(query, params);
    open = (appUrl) => {
      const db = createPostgresDb({ url: appUrl, max: 1 });
      return { query: (query, params) => db.query(query, params), close: () => db.close() };
    };
    standIn = await startDevManagementApi({ dbUrl: url, ref: REF, token: TOKEN });
    channel = managementDatabaseAdmin(
      createSupabaseManagementApi({ ref: REF, token: TOKEN, baseUrl: standIn.url }),
    );
    appDatabases = createAppDatabases({ url, sql, open, admin: channel });
    // A leftover from an interrupted run would make the create a no-op and the
    // whole suite pass vacuously.
    await deprovisionAppDatabase(sql, SLUG, channel);
    await deprovisionAppDatabase(sql, `${SLUG}${PREVIEW_SLUG_SUFFIX}`, channel);
  });

  afterAll(async () => {
    // Defensive: a failure in `beforeAll` still runs this, and a leaked database
    // or role outlives the run on a shared local stack.
    if (sql !== undefined && channel !== undefined) {
      await deprovisionAppDatabase(sql, SLUG, channel).catch(() => undefined);
    }
    await standIn?.close();
    await admin?.close();
  });

  test("a provision creates the database over HTTP, with its role and tables", async () => {
    const meta = await provisionAppDatabase(sql, SLUG, url, open, channel);
    expect(meta.role).toBe(APP_DB);
    expect(await databaseExists()).toBe(true);

    // The rest of provisioning is SQL on the admin connection, and it only works
    // if the database the control plane made is one this role can grant inside —
    // i.e. one it owns. That is the coupling the module doc warns about.
    const roles = await admin.query("select 1 from pg_roles where rolname = $1", [APP_DB]);
    expect(roles).toHaveLength(1);

    // The session-state tables live INSIDE the new database, so reading them
    // needs a connection into it — and their presence is what proves the
    // control plane made a database the admin role can then work in.
    const appDb = open(withDatabase(url, APP_DB));
    try {
      const tables = await appDb.query(
        "select tablename from pg_tables where schemaname = $1 order by tablename",
        [APP_DB_SCHEMA],
      );
      expect(tables.map((row) => row.tablename)).toEqual([
        SESSION_EVENT_TABLE,
        SESSION_STATE_TABLE,
      ]);
    } finally {
      await appDb.close();
    }

    // CONNECT revoked from PUBLIC — the tenant boundary, read off a real catalog
    // rather than off a recorded statement. An ACL entry with an empty grantee is
    // PUBLIC's; `c` in it would be CONNECT, and `T` alone is the TEMPORARY that
    // Postgres also grants by default and that provisioning leaves alone.
    const [row] = await admin.query(
      "select datacl::text as acl from pg_database where datname = $1",
      [APP_DB],
    );
    const acl = String(row?.acl ?? "");
    expect(acl).toContain(`${APP_DB}=`);
    expect(acl).not.toMatch(/(^|,)"?=[^/]*c/);
  });

  test("a second provision is idempotent, and rotates the password", async () => {
    // The existence check is a catalog read on the admin connection; the create
    // never leaves. Nothing about that changes with the channel in front of it.
    const first = await provisionAppDatabase(sql, SLUG, url, open, channel);
    const second = await provisionAppDatabase(sql, SLUG, url, open, channel);
    expect(second.password).not.toBe(first.password);
    expect(await databaseExists()).toBe(true);
  });

  test("a lost create race is absorbed as 42P04, through the wire", async () => {
    // The SQLSTATE has to survive being rendered into a message by the endpoint
    // and lifted back out by the client — otherwise two concurrent provisions
    // fail a deploy that should have succeeded. Going straight at the channel is
    // what skips the platform's existence check and forces the collision.
    await provisionAppDatabase(sql, SLUG, url, open, channel);
    await expect(channel.createDatabase(APP_DB)).rejects.toMatchObject({ code: "42P04" });
    // And the platform's own path still absorbs it.
    await expect(provisionAppDatabase(sql, SLUG, url, open, channel)).resolves.toMatchObject({
      role: APP_DB,
    });
  });

  test("a deprovision drops the database over HTTP, and is idempotent", async () => {
    await provisionAppDatabase(sql, SLUG, url, open, channel);
    await deprovisionAppDatabase(sql, SLUG, channel);
    expect(await databaseExists()).toBe(false);
    // `if exists`, so the sweep can run over an app that is already gone.
    await expect(deprovisionAppDatabase(sql, SLUG, channel)).resolves.toBeUndefined();
  });

  test("`appDbAdmin` resolves this channel from a dev-shaped environment", async () => {
    // The last gap between this suite and `pnpm dev:aai-server`: the env
    // `dev-server.mjs` produces has to be one the platform's own resolution
    // accepts — a loopback admin URL carries no project ref, so the explicit
    // one is doing real work here.
    const resolved = appDbAdmin({
      url,
      env: {
        AAI_LOCAL_DEV: "1",
        SUPABASE_ACCESS_TOKEN: TOKEN,
        SUPABASE_MANAGEMENT_URL: standIn.url,
      },
      refOverride: REF,
    });
    if (resolved === undefined) expect.fail("appDbAdmin resolved no channel for a dev env");
    expect(resolved.ref).toBe(REF);
    await provisionAppDatabase(sql, SLUG, url, open, resolved);
    expect(await databaseExists()).toBe(true);
    await deprovisionAppDatabase(sql, SLUG, resolved);
    expect(await databaseExists()).toBe(false);
  });

  test("the orphan-preview reap drops a real database through this channel", async () => {
    // What used to be a pg_cron body with a dblink drop, end to end: a real
    // agents row, a real anti-join against `studio_workspaces`, and a real
    // `drop database` leaving over HTTP. The pieces the SQL version could not
    // reach — the app database on its own cluster, and the row deleted LAST —
    // are the ones this asserts.
    //
    // In a THROWAWAY database, for the reason `pg-cron.scenario.test.ts` gives
    // about the sweep bodies it executes: the candidate read is global by
    // construction, so on the shared stack it would reap a developer's real
    // previews and, in a full tier run, the rows another suite just seeded.
    // Verified: this passed alone and failed inside `test:scenario` until the
    // read was isolated.
    const dbName = `aai_reap_test_${process.pid}_${APP_DB.slice(4, 12)}`;
    await admin.query(`create database "${dbName}"`);
    const scoped = createPostgresDb({ url: withDatabase(url, dbName), max: 2 });
    const scopedSql: SqlExec = (query, params) => scoped.query(query, params);
    try {
      await ensurePlatformTables(scopedSql);
      const secrets = createMemorySecretStore();
      // The agents rows are the REAL Postgres ones — the candidate read is a
      // query against `aai_platform.agents`, so a memory store would let the
      // reap "succeed" against a row the sweep never saw.
      const agents = createPgAgentRows(scopedSql);
      const store = createBundleStore(createMemoryBlobStorage(), { secrets, agents });
      const previewSlug = `${SLUG}${PREVIEW_SLUG_SUFFIX}`;
      const previewDb = appDbIdentifier(previewSlug);
      const aged = async (slug: string): Promise<void> => {
        await agents.put({
          slug,
          credential_hashes: [],
          worker_hash: "0".repeat(64),
          client_files: {},
        });
        await scopedSql(
          "update aai_platform.agents set updated_at = now() - interval '2 hours' where slug = $1",
          [slug],
        );
      };

      await provisionAppDatabase(sql, previewSlug, url, open, channel);
      await secrets.put(
        appDbSecretName(previewSlug),
        JSON.stringify({ role: previewDb, password: "0".repeat(32), url }),
      );
      await aged(previewSlug);

      // A second preview a workspace CLAIMS, through the same document shape the
      // studio writes: the anti-join reads `preview_slug`, a stored generated
      // column over `doc->>'previewSlug'`, and against a double-encoded doc that
      // computes NULL for every row — which deleted previews in use, hourly.
      const claimed = `claimed${PREVIEW_SLUG_SUFFIX}`;
      await aged(claimed);
      await createPgWorkspaceStore(scopedSql).put(
        "reap-scope",
        "claimer",
        { files: {}, previewSlug: claimed },
        null,
      );

      const sweep = createOrphanPreviewSweep({
        // The REAL reserved connection: the leader lock is a transaction, and
        // postgres.js refuses a bare `begin` on a pool ("UNSAFE_TRANSACTION").
        adminDb: scoped,
        env: { store, secrets, slugLock: (_slug, fn) => fn(), appDb: appDatabases },
      });
      // The unclaimed one only — a claimed preview is live, however aged.
      expect(await sweep.sweepOnce()).toMatchObject({ swept: true, reaped: [previewSlug] });
      expect(await agents.get(claimed)).not.toBeNull();

      // The database is gone, and so is the row that named it — in that order, so
      // a crash between them leaves a candidate the next pass still sees.
      expect(await sql("select 1 from pg_database where datname = $1", [previewDb])).toEqual([]);
      expect(await agents.get(previewSlug)).toBeNull();
      expect(await secrets.get(appDbSecretName(previewSlug))).toBeNull();
    } finally {
      await scoped.close();
      await admin.query(`drop database if exists "${dbName}" with (force)`);
    }
  });

  test("the stand-in refuses a statement the platform never sends", async () => {
    // Its allowlist is rebuilt from the platform's own builders, so this is the
    // assertion that a future third statement fails loudly in dev rather than
    // quietly working locally and 400ing in production.
    const api = createSupabaseManagementApi({ ref: REF, token: TOKEN, baseUrl: standIn.url });
    await expect(api.query("select 1")).rejects.toThrow(/serves only the two statements/);
  });
});
