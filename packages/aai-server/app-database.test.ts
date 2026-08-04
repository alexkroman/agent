// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import {
  appDbConnectionUrl,
  appDbIdentifier,
  createAppDatabases,
  deprovisionAppDatabase,
  openAppDb,
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

    // A single multi-statement round trip, no bind params.
    expect(calls).toHaveLength(1);
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

describe("openAppDb", () => {
  test("builds a role-credentialed URL on the admin host/port/db", () => {
    // openAppDb only rewrites credentials; connection is lazy so this never dials.
    const db = openAppDb(
      { role: appDbIdentifier("x"), password: "0".repeat(32) },
      "postgres://postgres:admin-secret@db.example.supabase.co:6543/postgres",
    );
    expect(typeof db.query).toBe("function");
    expect(typeof db.close).toBe("function");
    void db.close();
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
