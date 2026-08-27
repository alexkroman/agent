// Copyright 2026 the AAI authors. MIT license.
/**
 * HOW an app database comes into existence and how it goes away: the two
 * statements that create and drop it, and the Supabase Management API they go
 * out on.
 *
 * `app-database.ts` owns everything else about a per-app database (the role, the
 * grants, the tenant boundary, the in-database DDL). This module owns only
 * `create database` and `drop database`, because those two are the ones that are
 * not ordinary SQL:
 *
 * - **Neither may run inside a transaction block** (`25001`). That is why the
 *   provisioning batch is split at all, why a multi-statement simple query is
 *   illegal for them, and why the orphan-preview reap had to leave pg_cron — a
 *   job body IS a transaction (`orphan-previews.ts`).
 * - **Both are control-plane operations**, not application data: they change
 *   what the cluster contains. On Supabase the supported channel for that is the
 *   Management API, not a Postgres connection that happens to hold `CREATEDB`.
 *
 * **There is one implementation and no fallback.** A SQL path beside this one
 * would be a second way to create a tenant's database that only production never
 * takes — the shape this repo keeps paying for, where the exercised path and the
 * deployed path are different code. So `DatabaseAdmin` has exactly one production
 * implementation, and a deployment with no Management API credentials has no
 * per-app databases at all rather than a quieter way to make them: outside local
 * dev {@link appDbAdmin} REFUSES BOOT, and in local dev it returns `undefined`
 * and the storage routes 503 the way they already do without a platform database.
 * The local Supabase stack has no control plane to call, and pointing a laptop's
 * token at a real project while `SUPABASE_DB_URL` is `127.0.0.1` would create
 * tenant databases in production from a dev machine — so that is a refusal too,
 * not a gap.
 *
 * **Every deprovision goes through here, the orphan-preview reap included.** That
 * reap used to drop databases in SQL from a pg_cron body, over `dblink`, which
 * made it a second implementation of this — and a weaker one (primary cluster
 * only, and it leaked with a warning when its DSN was unresolvable). It moved
 * into the server with this channel: `orphan-previews.ts`.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { isLocalDev } from "./_boot.ts";
import { type AppDbTarget, sqlState } from "./app-database.ts";
import { assertIdentifier } from "./app-db-identifier.ts";
import { APP_DB_TARGET_POOL_MAX } from "./constants.ts";
import { assertAppDbPooler } from "./platform-connection-config.ts";
import type { SqlExec } from "./secret-store.ts";
import {
  createSupabaseManagementApi,
  isProjectRef,
  projectRefFromDbUrl,
  type SupabaseManagementApi,
} from "./supabase-management.ts";

/** Postgres `active_sql_transaction`: the statement may not run in a transaction. */
const NOT_IN_TRANSACTION = "25001";

/**
 * Issues the two database-level statements for one cluster. One production
 * implementation ({@link managementDatabaseAdmin}); the seam exists so a caller's
 * tests do not have to speak HTTP, not so a second channel can be swapped in.
 */
export type DatabaseAdmin = {
  /** The project the statements are issued against — boot output and errors. */
  readonly ref: string;
  createDatabase(id: string): Promise<void>;
  /** Idempotent (`if exists`), and forceful — see {@link dropDatabaseSql}. */
  dropDatabase(id: string): Promise<void>;
};

/** `create database` has no `if not exists`; the caller checks first and absorbs `42P04`. */
export function createDatabaseSql(id: string): string {
  return `create database "${assertIdentifier(id)}"`;
}

/**
 * `with (force)` terminates whatever backends are still connected, which is the
 * normal case rather than an edge one: the app's guest holds a `ctx.db` pool and a
 * delete does not wait for a sandbox to retire. Without it the drop fails
 * `55006 database is being accessed by other users`.
 */
export function dropDatabaseSql(id: string): string {
  return `drop database if exists "${assertIdentifier(id)}" with (force)`;
}

/** The two statements, through one project's Management API query endpoint. */
export function managementDatabaseAdmin(api: SupabaseManagementApi): DatabaseAdmin {
  const run = async (statement: string): Promise<void> => {
    try {
      await api.query(statement);
    } catch (err) {
      throw sqlState(err) === NOT_IN_TRANSACTION ? transactionBlockError(statement, err) : err;
    }
  };
  return {
    ref: api.ref,
    createDatabase: (id) => run(createDatabaseSql(id)),
    dropDatabase: (id) => run(dropDatabaseSql(id)),
  };
}

/**
 * `25001` from the control plane means the query endpoint ran the statement
 * inside a transaction, which no amount of retrying fixes — and the raw SQLSTATE
 * reads as a bug in this code rather than as a property of the channel. Name what
 * happened, and keep `code` so a caller's SQLSTATE check is unaffected.
 */
function transactionBlockError(statement: string, cause: unknown): Error {
  return Object.assign(
    new Error(
      `The Supabase Management API ran "${statement}" inside a transaction block ` +
        "(25001), which this statement may never be. This is a property of the control " +
        "plane, not of the request: retrying cannot help.",
      { cause },
    ),
    { code: NOT_IN_TRANSACTION },
  );
}

/**
 * The Management API channel for one cluster — or `undefined` in local dev, where
 * there is no control plane to call and per-app databases are therefore off.
 *
 * Outside local dev an unconfigured or unresolvable channel THROWS at boot: a
 * platform database whose apps cannot get a database is not a degraded
 * deployment, it is a broken one, and every symptom of it (a 503 from the storage
 * route, a durable workflow with nowhere to live) surfaces per request, later,
 * far from the cause. Same call this package already makes for the Realtime
 * credentials.
 */
export function appDbAdmin(opts: {
  /** The cluster's admin URL — the locator, and where the project ref comes from. */
  url: string;
  env: NodeJS.ProcessEnv;
  /**
   * `SUPABASE_PROJECT_REF`, when this is the PRIMARY cluster. Deliberately not
   * read from `env` here: with several clusters configured, one ref cannot be
   * right for all of them, and a ref applied to the wrong cluster is exactly the
   * "statements land on somebody else's project" failure the derivation avoids.
   */
  refOverride?: string | undefined;
}): DatabaseAdmin | undefined {
  const token = opts.env.SUPABASE_ACCESS_TOKEN?.trim();
  const override = opts.refOverride?.trim();
  const ref = override || projectRefFromDbUrl(opts.url);
  const host = hostOf(opts.url);
  if (token && ref) {
    if (!isProjectRef(ref)) throw new Error(refShapeMessage(ref));
    console.info(`App databases on ${host}: create/drop via the Supabase Management API (${ref}).`);
    return managementDatabaseAdmin(
      createSupabaseManagementApi(
        // `SUPABASE_MANAGEMENT_URL` unset means the SDK's own default control
        // plane; it exists for a staging endpoint and for a local mock.
        { ref, token, baseUrl: opts.env.SUPABASE_MANAGEMENT_URL?.trim() || undefined },
      ),
    );
  }
  if (isLocalDev(opts.env)) {
    console.warn(
      `No Supabase Management API for ${host} (${token ? "no project ref" : "no SUPABASE_ACCESS_TOKEN"}): ` +
        "per-app databases are OFF for this run, so `ctx.db`, agent storage and durable " +
        "workflows are unavailable and the storage routes 503. The local stack has no " +
        "control plane; point SUPABASE_DB_URL at a real project to develop against one.",
    );
    return undefined;
  }
  throw new Error(missingChannelMessage(host, token !== undefined && token !== ""));
}

function missingChannelMessage(host: string, hasToken: boolean): string {
  return hasToken
    ? `SUPABASE_ACCESS_TOKEN is set but no Supabase project ref could be resolved for ${host}. ` +
        "`create database` / `drop database` are issued through the Supabase Management API " +
        "and there is no SQL fallback, so a ref is required: a Supabase URL carries it as " +
        "`db.<ref>.supabase.co` or as the pooler username suffix `postgres.<ref>`, and " +
        "SUPABASE_PROJECT_REF names it explicitly."
    : "SUPABASE_ACCESS_TOKEN is required alongside SUPABASE_DB_URL: per-app databases are " +
        "created and dropped through the Supabase Management API, which needs a personal " +
        "access token (`sbp_…`) for the project. Generate one at " +
        "https://supabase.com/dashboard/account/tokens.";
}

function refShapeMessage(ref: string): string {
  return (
    `SUPABASE_PROJECT_REF="${ref}" is not a Supabase project ref (20 lowercase ` +
    "alphanumerics). Control-plane statements would be issued against it verbatim."
  );
}

/** Hostname only: the admin URL carries a password that must never reach a log. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "the configured cluster";
  }
}

/**
 * The extra placement clusters (`APP_DB_URLS`, comma-separated) as targets, each
 * with its own pool, its own project and its own POOLER: a fleet is several
 * Supabase projects, and the ref is per cluster, so each one's channel and each
 * one's Supavisor are resolved from its own entry.
 *
 * Lives here rather than in `service-config.ts` because a target is not just a
 * connection any more — it is a connection PLUS the answer to "how does DDL reach
 * this cluster", and both halves come from the same URL. Declaring `APP_DB_URLS`
 * is a deliberate production act, so a cluster whose channel cannot be resolved
 * throws even in local dev (`appDbAdmin` is called with no override, and its
 * local-dev `undefined` is not a legal target).
 *
 * ## An entry may carry its pooler, and until it could, sharding was BROKEN
 *
 * `<adminUrl>` or `<adminUrl>|<poolerUrl>`. The second form exists because
 * `withPoolerHost` moves an app URL's host onto the pooler's, and the pooler was
 * a single `APP_DB_POOLER_URL` for the whole fleet — so an app placed on an extra
 * cluster was addressed at the PRIMARY's Supavisor while carrying the EXTRA
 * project's tenant suffix on its username (`withDatabase` copies the suffix off
 * the cluster's own admin URL, correctly). Supavisor identifies the tenant from
 * that suffix and the primary's does not know it, so every connection for a
 * sharded app failed — the guest's own `DATABASE_URL` included, not merely the
 * platform's reads. That made the one mechanism that relieves the connection
 * ceiling unusable in exactly the configuration it exists for, silently, and
 * with `APP_DB_POOLER_URL` set (which is production) it could not have worked.
 *
 * `|` is the separator because it cannot appear unencoded in a URL's authority,
 * so an entry that means one thing cannot parse as two. An entry with no pooler
 * is DIRECT to that cluster, which is legitimate (a self-hosted Postgres, a
 * local stack) and understated by no budget, since an extra cluster's
 * connections are its own — see `appDbClusterConnectionsPerReplica`.
 */
export function extraAppDbTargets(env: NodeJS.ProcessEnv): AppDbTarget[] {
  return (env.APP_DB_URLS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const { url, poolerUrl } = parseClusterEntry(entry);
      const admin = appDbAdmin({ url, env });
      if (admin === undefined) throw new Error(missingChannelMessage(hostOf(url), false));
      const db = createPostgresDb({ url, max: APP_DB_TARGET_POOL_MAX });
      const sql: SqlExec = (query, params) => db.query(query, params);
      return { url, sql, admin, ...omitUndefined({ poolerUrl }) } satisfies AppDbTarget;
    });
}

/**
 * Split one `APP_DB_URLS` entry into its admin URL and its optional pooler.
 *
 * The pooler is validated by the same two rules the primary's is
 * (`assertAppDbPooler`) — a per-cluster pooler held to a looser standard is the
 * silent half of the failure those assertions exist to name. A third field is
 * REFUSED rather than ignored: an entry with two separators is a typo, and
 * ignoring the tail is how it would reach production addressed at the wrong host.
 */
function parseClusterEntry(entry: string): { url: string; poolerUrl: string | undefined } {
  const parts = entry.split("|").map((part) => part.trim());
  if (parts.length > 2) {
    throw new Error(
      `APP_DB_URLS entry has ${parts.length - 1} pipe separators: an entry is a ` +
        "cluster's admin URL, optionally followed by one pipe and that cluster's " +
        "pooler URL. Clusters themselves are separated by commas.",
    );
  }
  const [url, pooler] = parts;
  if (url === undefined || url === "") {
    throw new Error("APP_DB_URLS entry has no admin URL before its pipe separator.");
  }
  if (pooler === undefined || pooler === "") return { url, poolerUrl: undefined };
  assertAppDbPooler(pooler, `APP_DB_URLS pooler for ${hostOf(url)}`);
  return { url, poolerUrl: pooler };
}
