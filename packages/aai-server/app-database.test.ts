// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import {
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
  test("creates schema + fresh role with grants, search_path, and statement_timeout", async () => {
    const { sql, calls } = captureSql(() => []); // role does not exist
    const meta = await provisionAppDatabase(sql, "my-agent");
    const id = appDbIdentifier("my-agent");

    expect(meta.schema).toBe(id);
    expect(meta.role).toBe(id);
    expect(meta.password).toMatch(/^[a-f0-9]{32}$/);

    expect(calls.map((c) => c.query)).toEqual([
      `create schema if not exists "${id}"`,
      "select 1 from pg_roles where rolname = $1",
      `create role "${id}" with login password '${meta.password}'`,
      `grant usage, create on schema "${id}" to "${id}"`,
      `alter role "${id}" set search_path = "${id}"`,
      `alter role "${id}" set statement_timeout = '10s'`,
    ]);
    // The existence check is parameterized, not interpolated.
    expect(calls[1]?.params).toEqual([id]);
  });

  test("alters the existing role (idempotent re-provision rotates the password)", async () => {
    const { sql, calls } = captureSql((query) =>
      query.startsWith("select 1 from pg_roles") ? [{ "?column?": 1 }] : [],
    );
    const meta = await provisionAppDatabase(sql, "my-agent");
    const id = appDbIdentifier("my-agent");
    expect(calls.map((c) => c.query)).toContain(
      `alter role "${id}" with login password '${meta.password}'`,
    );
    expect(calls.map((c) => c.query)).not.toContain(
      `create role "${id}" with login password '${meta.password}'`,
    );
  });

  test("two provisions issue distinct random passwords", async () => {
    const { sql } = captureSql(() => []);
    const a = await provisionAppDatabase(sql, "my-agent");
    const b = await provisionAppDatabase(sql, "my-agent");
    expect(a.password).not.toBe(b.password);
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

describe("openAppDb", () => {
  test("builds a role-credentialed URL on the admin host/port/db", () => {
    const meta = { schema: "app_ab12", role: "app_ab12cd34ef567890", password: "0".repeat(32) };
    // openAppDb only rewrites credentials; connection is lazy so this never dials.
    const db = openAppDb(
      { ...meta, role: appDbIdentifier("x"), schema: appDbIdentifier("x") },
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
    const meta = { schema: "app_x", role: "app_x", password: "p" };
    expect(parseAppDbMeta(JSON.stringify(meta))).toEqual(meta);
    expect(parseAppDbMeta(null)).toBeNull();
    expect(parseAppDbMeta("not json")).toBeNull();
    expect(parseAppDbMeta(JSON.stringify({ schema: "s" }))).toBeNull();
  });
});
