// Copyright 2026 the AAI authors. MIT license.
import { sessionStateDdl } from "@alexkroman1/aai/runtime";
import { describe, expect, test, vi } from "vitest";
import {
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

describe("appDbIdentifier", () => {
  test("is deterministic and shaped app_<16 hex>", () => {
    const id = appDbIdentifier("my-agent");
    expect(id).toMatch(/^app_[a-f0-9]{16}$/);
    expect(appDbIdentifier("my-agent")).toBe(id);
    expect(appDbIdentifier("other-agent")).not.toBe(id);
  });
});

describe("provisionAppDatabase", () => {
  test("creates schema + role with grants, search_path, and statement_timeout in one batch", async () => {
    const { sql, calls } = captureSql();
    const meta = await provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db");
    const id = appDbIdentifier("my-agent");

    expect(meta.role).toBe(id);
    expect(meta.password).toMatch(/^[a-f0-9]{32}$/);

    // The provisioning BATCH is one multi-statement round trip with no bind
    // params; the session-state DDL follows as its own statements (see
    // `ensureSessionTables` — kept out of the batch that interpolates a
    // password, so a failure there cannot carry the credential into a log).
    expect(calls).toHaveLength(3);
    const call = calls[0];
    expect(call?.params).toBeUndefined();
    const query = call?.query ?? "";
    expect(query).toContain(`create schema if not exists "${id}"`);
    // Create-or-alter branches on role existence server-side in a do-block.
    expect(query).toContain(`select 1 from pg_roles where rolname = '${id}'`);
    expect(query).toContain(
      `alter role "${id}" with login password '${meta.password}' connection limit 4`,
    );
    expect(query).toContain(
      `create role "${id}" with login password '${meta.password}' connection limit 4`,
    );
    expect(query).toContain(`grant usage, create on schema "${id}" to "${id}"`);
    expect(query).toContain(`alter role "${id}" set search_path = "${id}"`);
    expect(query).toContain(`alter role "${id}" set statement_timeout = '10s'`);
    // Per-tenant caps: temp scratch bound is best-effort (superuser GUC).
    expect(query).toContain(`alter role "${id}" set temp_file_limit = '64MB'`);
    expect(query).toContain("insufficient_privilege");
    // The locator records which cluster the app was placed on.
    expect(meta.url).toBe("postgres://admin@primary/db");
  });

  test("provisions the session-state tables, qualified by the app's schema", async () => {
    // The invariant: a provisioned app schema HAS its tables. They used to be
    // created by the guest on first use, which cost two round trips and a `42P07`
    // NOTICE on every boot for a guarantee `if not exists` cannot give — a newer
    // SDK expecting an added column was broken either way.
    const { sql, calls } = captureSql();
    await provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db");
    const id = appDbIdentifier("my-agent");

    const ddl = calls.slice(1).map((c) => c.query);
    expect(ddl).toHaveLength(2);
    // QUALIFIED, because this runs on the platform admin connection whose
    // `search_path` is pinned nowhere — the app's own role is, which is why the
    // guest never had to qualify and this does.
    expect(ddl[0]).toContain(`create table if not exists "${id}".aai_session_state`);
    expect(ddl[1]).toContain(`create table if not exists "${id}".aai_session_events`);
    // The DDL text is the SDK's, so neither side can drift from the other.
    for (const statement of sessionStateDdl(id)) {
      expect(ddl).toContain(statement);
    }
  });

  test("two provisions issue distinct random passwords", async () => {
    const { sql } = captureSql(() => []);
    const a = await provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db");
    const b = await provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db");
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
    const failure = await provisionAppDatabase(sql, "my-agent", "postgres://admin@primary/db").then(
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
  test("drops the schema cascade and the role", async () => {
    const { sql, calls } = captureSql();
    await deprovisionAppDatabase(sql, "my-agent");
    const id = appDbIdentifier("my-agent");
    expect(calls.map((c) => c.query)).toEqual([
      `drop schema if exists "${id}" cascade`,
      `drop role if exists "${id}"`,
    ]);
  });
});

describe("appDatabaseUsage", () => {
  test("counts tables, rows and bytes for the app's own schema only", async () => {
    const { sql, calls } = captureSql(() => [{ tables: "2", rows: "17", bytes: "49152" }]);
    expect(await appDatabaseUsage(sql, "my-agent")).toEqual({
      tables: 2,
      rows: 17,
      bytes: 49_152,
    });
    // The schema is BOUND, never interpolated, and it is the derived
    // identifier rather than the slug.
    expect(calls[0]?.params).toEqual([appDbIdentifier("my-agent")]);
    expect(calls[0]?.query).toContain("table_schema = $1");
  });

  test("counts exactly, rather than reading the planner's estimate", async () => {
    // `reltuples` is -1 until the first ANALYZE and stale after every write,
    // so it reads zero for exactly the row somebody just wrote — which is the
    // question this exists to answer.
    const { sql, calls } = captureSql(() => [{ tables: "0", rows: "0", bytes: "0" }]);
    await appDatabaseUsage(sql, "my-agent");
    expect(calls[0]?.query).toContain("count(*)");
    expect(calls[0]?.query).not.toContain("reltuples");
  });

  test("an empty schema is zeroes, not a crash", async () => {
    const { sql } = captureSql(() => [{ tables: "0", rows: null, bytes: null }]);
    expect(await appDatabaseUsage(sql, "my-agent")).toEqual({ tables: 0, rows: 0, bytes: 0 });
  });

  test("a row that answers nothing degrades to zeroes rather than NaN", async () => {
    const { sql } = captureSql(() => []);
    expect(await appDatabaseUsage(sql, "my-agent")).toEqual({ tables: 0, rows: 0, bytes: 0 });
  });
});

describe("appDbConnectionUrl", () => {
  const meta = { role: appDbIdentifier("x"), password: "0".repeat(32) };

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
  test("builds a role-credentialed URL on the admin host/port/db", () => {
    const url = new URL(
      appDbUrlFor(
        { role: appDbIdentifier("x"), password: "0".repeat(32) },
        "postgres://postgres:admin-secret@db.example.supabase.co:6543/postgres",
      ),
    );
    expect(decodeURIComponent(url.username)).toBe(appDbIdentifier("x"));
    expect(url.host).toBe("db.example.supabase.co:6543");
  });

  test("the stored locator wins over the fallback admin URL", () => {
    const url = new URL(
      appDbUrlFor(
        {
          role: appDbIdentifier("x"),
          password: "0".repeat(32),
          url: "postgres://postgres:s@other-cluster.example:5432/postgres",
        },
        "postgres://postgres:admin-secret@db.example.supabase.co:6543/postgres",
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
   * the secret holding the real schema's only credential.
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
      extraTargets: [{ url: secondaryUrl, sql: secondary.sql }],
    });

    await appDb.deprovision("slug-a", {
      role: appDbIdentifier("slug-a"),
      password: "0".repeat(32),
      url: secondaryUrl,
    });

    expect(secondary.calls.map((c) => c.query)).toEqual([
      `drop schema if exists "${appDbIdentifier("slug-a")}" cascade`,
      `drop role if exists "${appDbIdentifier("slug-a")}"`,
    ]);
    expect(primary.calls).toEqual([]);
  });

  /**
   * No locator means the app's cluster is genuinely unknown — a secret
   * already swept, or an earlier partial failure. Guessing one leaves a live
   * schema behind; the drops are slug-derived and unique, so sweeping every
   * cluster is a real no-op wherever the app never lived.
   */
  test("deprovision without a locator sweeps every cluster", async () => {
    const primary = captureSql();
    const secondary = captureSql();
    const appDb = createAppDatabases({
      url: "postgres://postgres:pw@primary.example:5432/postgres",
      sql: primary.sql,
      extraTargets: [
        { url: "postgres://postgres:pw@cluster-b.example:5432/postgres", sql: secondary.sql },
      ],
    });

    await appDb.deprovision("slug-a");

    expect(primary.calls).toHaveLength(2);
    expect(secondary.calls).toHaveLength(2);
  });

  /** One unreachable cluster must not leave the others provisioned. */
  test("a failing cluster does not skip the rest, and still reports", async () => {
    const failing: SqlExec = vi.fn(() => Promise.reject(new Error("cluster down")));
    const healthy = captureSql();
    const appDb = createAppDatabases({
      url: "postgres://postgres:pw@primary.example:5432/postgres",
      sql: failing,
      extraTargets: [
        { url: "postgres://postgres:pw@cluster-b.example:5432/postgres", sql: healthy.sql },
      ],
    });

    await expect(appDb.deprovision("slug-a")).rejects.toThrow("cluster down");
    expect(healthy.calls).toHaveLength(2);
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
