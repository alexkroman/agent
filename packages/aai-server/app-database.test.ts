// Copyright 2026 the AAI authors. MIT license.
import { sessionStateDdl } from "@alexkroman1/aai/runtime";
import { describe, expect, test, vi } from "vitest";
import {
  type AppDbOpener,
  appDatabaseUsage,
  appDbConnectionUrl,
  appDbIdentifier,
  appDbUrlFor,
  createAppDatabases,
  deprovisionAppDatabase,
  parseAppDbMeta,
  provisionAppDatabase,
} from "./app-database.ts";
import type { SqlExec } from "./secret-store.ts";

function captureSql(respond: (query: string) => Record<string, unknown>[] = () => []) {
  const calls: { query: string; params?: unknown[] | undefined }[] = [];
  const sql: SqlExec = vi.fn(async (query, params) => {
    calls.push({ query, params });
    return respond(query);
  });
  return { sql, calls };
}

/**
 * Just the DROPs from a recorded deprovision.
 *
 * A deprovision also unschedules the app's cron jobs first (see
 * `deprovisionAppDatabase`), so an exact statement list would couple every
 * cluster-routing assertion below to that bookkeeping. What those specs are about
 * is WHICH CLUSTER the drops landed on.
 */
function dropStatements(calls: { query: string }[]): string[] {
  return calls.map((c) => c.query).filter((q) => q.startsWith("drop "));
}

/**
 * A recording {@link AppDbOpener}: provisioning's last steps and every usage read
 * run on a connection INTO the app's database, so a spec has to be able to see
 * both sides. `urls` records what was opened (the locator, which is what a
 * mis-derived database name would corrupt) and `closed` counts releases, because
 * an opener that is not closed is a leaked connection per provision.
 */
function captureOpener(respond: (query: string) => Record<string, unknown>[] = () => []) {
  const urls: string[] = [];
  const calls: { query: string; params?: unknown[] | undefined }[] = [];
  let closed = 0;
  const open: AppDbOpener = (url) => {
    urls.push(url);
    return {
      query: async (query, params) => {
        calls.push({ query, params });
        return respond(query);
      },
      close: async () => {
        closed += 1;
      },
    };
  };
  return { open, urls, calls, closed: () => closed };
}

describe("appDbIdentifier", () => {
  test("is deterministic and shaped app_<16 hex>", () => {
    const id = appDbIdentifier("my-agent");
    expect(id).toMatch(/^app_[a-f0-9]{16}$/);
    expect(appDbIdentifier("my-agent")).toBe(id);
    expect(appDbIdentifier("other-agent")).not.toBe(id);
  });
});

describe("provisionAppDatabase", () => {
  test("creates the role, then the DATABASE, then its grants", async () => {
    const { sql, calls } = captureSql();
    const { open, urls } = captureOpener();
    const meta = await provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db", open);
    const id = appDbIdentifier("my-agent");

    expect(meta.role).toBe(id);
    expect(meta.password).toMatch(/^[a-f0-9]{32}$/);

    // The ROLE batch is one multi-statement round trip with no bind params.
    const roleBatch = calls[0];
    expect(roleBatch?.params).toBeUndefined();
    const query = roleBatch?.query ?? "";
    expect(query).toContain(`select 1 from pg_roles where rolname = '${id}'`);
    expect(query).toContain(
      `alter role "${id}" with login password '${meta.password}' connection limit 10`,
    );
    expect(query).toContain(
      `create role "${id}" with login password '${meta.password}' connection limit 10`,
    );
    expect(query).toContain(`alter role "${id}" set statement_timeout = '10s'`);
    // Per-tenant caps: temp scratch bound is best-effort (superuser GUC).
    expect(query).toContain(`alter role "${id}" set temp_file_limit = '64MB'`);
    expect(query).toContain("insufficient_privilege");

    // No `search_path` pin any more: the app owns `public` in its OWN database,
    // which is what makes an unqualified `create table` through ctx.db work.
    expect(query).not.toContain("search_path");

    const statements = calls.map((c) => c.query);
    expect(statements).toContain(`create database "${id}"`);
    // THE tenant boundary. Postgres grants CONNECT on a new database to PUBLIC,
    // so without this revoke every app role can open every other app's database.
    // Batched with the grant beside it — one round trip, since they address the
    // same object and neither reads the other — so this is a substring check
    // rather than a whole-statement one.
    const boundary = statements.find((s) => s.includes("revoke connect on database"));
    expect(boundary).toContain(`revoke connect on database "${id}" from public`);
    expect(boundary).toContain(`grant connect, temporary, create on database "${id}" to "${id}"`);

    // The locator records which cluster the app was placed on.
    expect(meta.url).toBe("postgres://admin@primary/db");
    // And the in-database work opened the app's OWN database on that cluster.
    expect(urls).toEqual([`postgres://admin@primary/${id}`]);
  });

  test("issues `create database` as its own statement, never inside a batch", async () => {
    // `create database` cannot run in a transaction block, and a multi-statement
    // simple query IS one — the mirror of the `25001` that stops the orphan sweep
    // dropping a database from a pg_cron body. So it must be alone.
    const { sql, calls } = captureSql();
    const { open } = captureOpener();
    await provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db", open);
    const id = appDbIdentifier("my-agent");
    const createDb = calls.filter((c) => c.query.includes("create database"));
    expect(createDb).toHaveLength(1);
    expect(createDb[0]?.query).toBe(`create database "${id}"`);
  });

  test("skips `create database` when it already exists, and absorbs a lost race", async () => {
    // Existence is checked because there is no `if not exists`; the duplicate
    // SQLSTATE is absorbed because two provisions racing must both succeed — the
    // second one's real work is the password rotation.
    const existing = captureSql((q) => (q.includes("pg_database") ? [{ "?column?": 1 }] : []));
    await provisionAppDatabase(
      existing.sql,
      "my-agent",
      "postgres://admin@primary/db",
      captureOpener().open,
    );
    expect(existing.calls.map((c) => c.query)).not.toContain(
      `create database "${appDbIdentifier("my-agent")}"`,
    );

    const raced: SqlExec = vi.fn(async (query) => {
      if (query.startsWith("create database")) {
        const err = new Error("duplicate") as Error & { code: string };
        err.code = "42P04";
        throw err;
      }
      return [];
    });
    await expect(
      provisionAppDatabase(raced, "my-agent", "postgres://a@p/db", captureOpener().open),
    ).resolves.toMatchObject({ role: appDbIdentifier("my-agent") });
  });

  test("grants `public` and provisions the session-state tables INSIDE the new database", async () => {
    // The invariant: a provisioned app database HAS its tables. Both steps run on
    // a connection into that database — the admin pool cannot reach it, since a
    // Postgres connection is bound to one database.
    const { sql } = captureSql();
    const opener = captureOpener();
    await provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db", opener.open);
    const id = appDbIdentifier("my-agent");

    const inDb = opener.calls.map((c) => c.query);
    // Postgres 15+ made `public` owned by pg_database_owner and writable by
    // nobody else, so without this an app cannot create its own tables at all.
    expect(inDb[0]).toBe(`grant usage, create on schema public to "${id}"`);
    // Unqualified now — this runs INSIDE the app's database, where `public` is
    // simply the default. The DDL text is the SDK's, so neither side can drift.
    for (const statement of sessionStateDdl("public")) {
      expect(inDb).toContain(statement);
    }
    expect(inDb.some((q) => q.includes("aai_session_state"))).toBe(true);
    expect(inDb.some((q) => q.includes("aai_session_events"))).toBe(true);

    // And the app role is GRANTED them. The ADMIN creates these tables, so it owns
    // them — and a role holding `usage, create` on the schema has no privileges on
    // tables it did not create. Without this every session on an app with storage
    // failed `42501 permission denied for table aai_session_events`.
    // Slots take all four verbs — a slot value is a read-modify-write cell.
    const slotGrant = inDb.find((q) => q.includes(`on public.aai_session_state to "${id}"`));
    expect(slotGrant).toContain("grant select, insert, update, delete");
    // The EVENT log takes only two, and the revoke is what heals a database
    // provisioned before the split. `ctx.db` runs arbitrary SQL on this very
    // role, so `delete` here is a tool deleting its own audit trail.
    const eventGrant = inDb.find((q) => q.includes(`on public.aai_session_events to "${id}"`));
    expect(eventGrant).toContain("grant select, insert");
    expect(eventGrant).not.toContain("delete");
    expect(inDb).toContainEqual(
      expect.stringContaining(`revoke update, delete on public.aai_session_events from "${id}"`),
    );
    // DML only: ownership stays with the admin, so the tenant cannot drop or alter
    // the framework's own session store, and the admin-run sweep needs no grant.
    for (const forbidden of ["all privileges", "drop", "truncate", "references"]) {
      expect(slotGrant?.toLowerCase()).not.toContain(forbidden);
      expect(eventGrant?.toLowerCase()).not.toContain(forbidden);
    }
    // The connection is released, or every provision leaks one.
    expect(opener.closed()).toBe(1);
  });

  test("closes the in-database connection even when its DDL fails", async () => {
    const { sql } = captureSql();
    let closed = 0;
    const open: AppDbOpener = () => ({
      query: async () => {
        throw new Error("in-database DDL failed");
      },
      close: async () => {
        closed += 1;
      },
    });
    await expect(
      provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db", open),
    ).rejects.toThrow("in-database DDL failed");
    expect(closed).toBe(1);
  });

  test("two provisions issue distinct random passwords", async () => {
    const { sql } = captureSql(() => []);
    const { open } = captureOpener();
    const a = await provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db", open);
    const b = await provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db", open);
    expect(a.password).not.toBe(b.password);
  });

  test("a provisioning failure never leaks the password to the thrown error", async () => {
    // The password is inlined in the DDL and postgres drivers attach the
    // failing query as own properties — which the process safety nets
    // console.error wholesale. The rethrown error must carry no trace of it.
    const sql: SqlExec = vi.fn(async (query) => {
      const err = new Error(`syntax error in: ${query}`);
      (err as unknown as Record<string, unknown>).query = query;
      throw err;
    });
    const failure = await provisionAppDatabase(
      sql,
      "my-agent",
      "postgres://admin@primary/db",
      captureOpener().open,
    ).then(
      () => null,
      (err: unknown) => err as Error & { query?: string },
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("[redacted]");
    expect(failure?.query).toBe("[redacted]");
    expect(JSON.stringify({ ...failure, message: failure?.message })).not.toMatch(
      /login password '[a-f0-9]{32}'/,
    );
  });
});

describe("deprovisionAppDatabase", () => {
  test("drops the database with (force), then the role", async () => {
    const { sql, calls } = captureSql();
    await deprovisionAppDatabase(sql, "my-agent");
    const id = appDbIdentifier("my-agent");
    expect(dropStatements(calls)).toEqual([
      // `with (force)` because the app's guest normally still holds a ctx.db
      // pool — without it the drop fails `55006 being accessed by other users`.
      `drop database if exists "${id}" with (force)`,
      // A leftover SCHEMA from an app provisioned before per-app databases. It
      // has to go before the role: a role owning it cannot be dropped (`2BP01`),
      // which BLOCKED the delete of every such agent (a failed deprovision is a
      // 503 in `delete.ts`). A no-op for anything provisioned since.
      `drop schema if exists "${id}" cascade`,
      // Last, because both of the above can own objects that depend on it.
      `drop role if exists "${id}"`,
    ]);
  });

  test("unschedules the app's cron jobs BEFORE dropping its database", async () => {
    // A cron job naming a database that no longer exists does not clean itself
    // up: it fails on every tick forever and fills `cron.job_run_details`, which
    // is the table `aai-sweep-cron-history` exists to keep small.
    const { sql, calls } = captureSql((q) =>
      q.includes("from cron.job") ? [{ jobname: "aai-app-session-state-x" }] : [],
    );
    await deprovisionAppDatabase(sql, "my-agent");
    const queries = calls.map((c) => c.query);
    expect(queries.findIndex((q) => q.includes("cron.unschedule"))).toBeLessThan(
      queries.findIndex((q) => q.includes("drop database")),
    );
  });

  test("a deprovision is not failed by pg_cron being absent", async () => {
    // The drops are the point; the janitorial bookkeeping is not worth refusing a
    // delete over, and `delete.ts` turns a deprovision failure into a 503.
    const sql: SqlExec = vi.fn(async (query) => {
      if (query.includes("cron.")) throw new Error("pg_cron is not installed");
      return [];
    });
    await expect(deprovisionAppDatabase(sql, "my-agent")).resolves.toBeUndefined();
  });
});

describe("appDatabaseUsage", () => {
  test("counts tables, rows and bytes across the app's own schemas", async () => {
    const { sql, calls } = captureSql(() => [{ tables: "2", rows: "17", bytes: "49152" }]);
    expect(await appDatabaseUsage(sql)).toEqual({ tables: 2, rows: 17, bytes: 49_152 });
    // No schema parameter at all now: this runs INSIDE the app's database, so
    // "the app's tables" is everything that is not a system schema.
    expect(calls[0]?.params).toBeUndefined();
    expect(calls[0]?.query).toContain("pg_catalog");
    expect(calls[0]?.query).toContain("information_schema");
  });

  test("sums relation sizes rather than pg_database_size", async () => {
    // `pg_database_size` is one cheap call and the wrong answer: a fresh database
    // inherits ~7.5 MB of template catalog, so every EMPTY app would report 7.5 MB
    // to its author as their own usage. Measured on PG 17.6.
    const { sql, calls } = captureSql(() => [{ tables: "0", rows: "0", bytes: "0" }]);
    await appDatabaseUsage(sql);
    expect(calls[0]?.query).toContain("pg_total_relation_size");
    expect(calls[0]?.query).not.toContain("pg_database_size");
  });

  test("counts exactly, rather than reading the planner's estimate", async () => {
    // `reltuples` is -1 until the first ANALYZE and stale after every write,
    // so it reads zero for exactly the row somebody just wrote — which is the
    // question this exists to answer.
    const { sql, calls } = captureSql(() => [{ tables: "0", rows: "0", bytes: "0" }]);
    await appDatabaseUsage(sql);
    expect(calls[0]?.query).toContain("count(*)");
    expect(calls[0]?.query).not.toContain("reltuples");
  });

  test("an empty database is zeroes, not a crash", async () => {
    const { sql } = captureSql(() => [{ tables: "0", rows: null, bytes: null }]);
    expect(await appDatabaseUsage(sql)).toEqual({ tables: 0, rows: 0, bytes: 0 });
  });

  test("a row that answers nothing degrades to zeroes rather than NaN", async () => {
    const { sql } = captureSql(() => []);
    expect(await appDatabaseUsage(sql)).toEqual({ tables: 0, rows: 0, bytes: 0 });
  });
});

describe("appDbConnectionUrl", () => {
  const meta = { role: appDbIdentifier("x"), password: "0".repeat(32) };

  test("points at the app's OWN database, not the platform's", () => {
    // The whole rearchitecture in one assertion. Under the per-schema model this
    // path stayed `/postgres` and isolation came from a `search_path` pin; now the
    // database IS the isolation, and the Workflow DevKit can create its
    // `workflow` / `graphile_worker` schemas because it owns the database.
    const url = new URL(
      appDbConnectionUrl(meta, "postgres://postgres:admin-secret@db.example.com:5432/postgres"),
    );
    expect(url.pathname).toBe(`/${meta.role}`);
  });

  test("carries the pooler tenant suffix from the admin username onto the app role", () => {
    // Supavisor identifies the tenant by the `.suffix` on the username; a
    // bare role gets "(ENOIDENTIFIER) no tenant identifier provided".
    const url = new URL(
      appDbConnectionUrl(
        meta,
        "postgres://postgres.projref:admin-secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
      ),
    );
    expect(decodeURIComponent(url.username)).toBe(`${meta.role}.projref`);
    expect(url.hostname).toBe("aws-0-us-east-1.pooler.supabase.com");
    // Supavisor reads the database out of the startup packet into its pool key,
    // so an arbitrary database name works through the pooler on both ports.
    expect(url.pathname).toBe(`/${meta.role}`);
  });

  test("leaves the role bare for direct (non-pooler) admin usernames", () => {
    const url = new URL(
      appDbConnectionUrl(meta, "postgres://postgres:admin-secret@db.example.com:5432/postgres"),
    );
    expect(decodeURIComponent(url.username)).toBe(meta.role);
    expect(decodeURIComponent(url.password)).toBe(meta.password);
  });
});

describe("appDbUrlFor", () => {
  test("builds a role-credentialed URL on the admin host/port, own database", () => {
    const url = new URL(
      appDbUrlFor(
        { role: appDbIdentifier("x"), password: "0".repeat(32) },
        "postgres://postgres:admin-secret@db.example.supabase.co:5432/postgres",
      ),
    );
    expect(decodeURIComponent(url.username)).toBe(appDbIdentifier("x"));
    expect(url.host).toBe("db.example.supabase.co:5432");
    expect(url.pathname).toBe(`/${appDbIdentifier("x")}`);
  });

  test("the stored locator wins over the fallback admin URL", () => {
    const url = new URL(
      appDbUrlFor(
        {
          role: appDbIdentifier("x"),
          password: "0".repeat(32),
          url: "postgres://postgres:s@other-cluster.example:5432/postgres",
        },
        "postgres://postgres:admin-secret@db.example.supabase.co:5432/postgres",
      ),
    );
    expect(url.host).toBe("other-cluster.example:5432");
  });
});

describe("createAppDatabases", () => {
  test("binds provision/deprovision to the injected sql handle", async () => {
    const { sql, calls } = captureSql(() => []);
    const appDb = createAppDatabases({
      url: "postgres://postgres:pw@localhost:5432/postgres",
      sql,
      open: captureOpener().open,
    });
    await appDb.provision("slug-a");
    await appDb.deprovision("slug-a");
    expect(calls.length).toBeGreaterThan(0);
  });

  /**
   * Placement is `hash(slug) % targets.length`, so adding or removing a
   * cluster re-shuffles every existing app. The stored locator is the only
   * record that survives that, and deprovision used to recompute the
   * placement instead — issuing both `if exists` drops against a cluster that
   * never hosted the app (silent no-ops) while the caller went on to delete
   * the secret holding the real database's only credential.
   *
   * The primary is deliberately the target `pickAppDbTarget` chooses for this
   * slug, so a recomputing implementation passes every other assertion here
   * and fails only this one.
   */
  test("deprovision drops on the cluster the stored locator names", async () => {
    const primary = captureSql();
    const secondary = captureSql();
    const secondaryUrl = "postgres://postgres:pw@cluster-b.example:5432/postgres";
    const appDb = createAppDatabases({
      url: "postgres://postgres:pw@primary.example:5432/postgres",
      sql: primary.sql,
      open: captureOpener().open,
      extraTargets: [{ url: secondaryUrl, sql: secondary.sql }],
    });

    await appDb.deprovision("slug-a", {
      role: appDbIdentifier("slug-a"),
      password: "0".repeat(32),
      url: secondaryUrl,
    });

    expect(dropStatements(secondary.calls)).toEqual([
      `drop database if exists "${appDbIdentifier("slug-a")}" with (force)`,
      `drop schema if exists "${appDbIdentifier("slug-a")}" cascade`,
      `drop role if exists "${appDbIdentifier("slug-a")}"`,
    ]);
    expect(primary.calls).toEqual([]);
  });

  /**
   * No locator means the app's cluster is genuinely unknown — a secret
   * already swept, or an earlier partial failure. Guessing one leaves a live
   * database behind; the drops are slug-derived and unique, so sweeping every
   * cluster is a real no-op wherever the app never lived.
   */
  test("deprovision without a locator sweeps every cluster", async () => {
    const primary = captureSql();
    const secondary = captureSql();
    const appDb = createAppDatabases({
      url: "postgres://postgres:pw@primary.example:5432/postgres",
      sql: primary.sql,
      open: captureOpener().open,
      extraTargets: [
        { url: "postgres://postgres:pw@cluster-b.example:5432/postgres", sql: secondary.sql },
      ],
    });

    await appDb.deprovision("slug-a");

    expect(dropStatements(primary.calls)).toHaveLength(3);
    expect(dropStatements(secondary.calls)).toHaveLength(3);
  });

  /** One unreachable cluster must not leave the others provisioned. */
  test("a failing cluster does not skip the rest, and still reports", async () => {
    const failing: SqlExec = vi.fn(() => Promise.reject(new Error("cluster down")));
    const healthy = captureSql();
    const appDb = createAppDatabases({
      url: "postgres://postgres:pw@primary.example:5432/postgres",
      sql: failing,
      open: captureOpener().open,
      extraTargets: [
        { url: "postgres://postgres:pw@cluster-b.example:5432/postgres", sql: healthy.sql },
      ],
    });

    await expect(appDb.deprovision("slug-a")).rejects.toThrow("cluster down");
    expect(dropStatements(healthy.calls)).toHaveLength(3);
  });
});

describe("parseAppDbMeta", () => {
  test("parses a valid record and rejects malformed ones", () => {
    const meta = { role: "app_x", password: "p" };
    expect(parseAppDbMeta(JSON.stringify(meta))).toEqual(meta);
    // A legacy record's extra `schema` field is ignored, not preserved.
    expect(parseAppDbMeta(JSON.stringify({ ...meta, schema: "app_x" }))).toEqual(meta);
    expect(parseAppDbMeta(null)).toBeNull();
    expect(parseAppDbMeta("not json")).toBeNull();
    expect(parseAppDbMeta(JSON.stringify({ role: "r" }))).toBeNull();
  });
});
