// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { appDbIdentifier } from "./app-database.ts";
import { createDatabaseSql, dropDatabaseSql } from "./app-db-admin.ts";
import { devManagementApp, isAppDbStatement, startDevManagementApi } from "./dev-management-api.ts";
import type { SqlExec } from "./secret-store.ts";

const REF = "localdevlocaldevloca";
const TOKEN = "dev-token";
const ID = appDbIdentifier("my-agent");
const PATH = `/v1/projects/${REF}/database/query`;

function app(sql: SqlExec = vi.fn(async () => [])) {
  return { app: devManagementApp({ ref: REF, token: TOKEN, sql }), sql };
}

function post(
  query: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query }),
  };
}

describe("isAppDbStatement", () => {
  test("accepts exactly what the platform's channel issues", () => {
    // Rebuilt from the same builders, so the allowlist cannot drift from the
    // statement text — a change to either builder changes this with it.
    expect(isAppDbStatement(createDatabaseSql(ID))).toBe(true);
    expect(isAppDbStatement(dropDatabaseSql(ID))).toBe(true);
  });

  test("refuses everything else, including near-misses", () => {
    expect(isAppDbStatement(`drop database "${ID}"`)).toBe(false);
    expect(isAppDbStatement(`create database "${ID}" template template0`)).toBe(false);
    expect(isAppDbStatement(`select * from "${ID}"`)).toBe(false);
    expect(isAppDbStatement("drop database postgres")).toBe(false);
    expect(isAppDbStatement("")).toBe(false);
  });
});

describe("devManagementApp", () => {
  test("runs an allowed statement and answers with its rows", async () => {
    const sql: SqlExec = vi.fn(async () => []);
    const res = await app(sql).app.request(PATH, post(createDatabaseSql(ID)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(sql).toHaveBeenCalledWith(createDatabaseSql(ID));
  });

  test("rejects a wrong or missing bearer before anything else", async () => {
    const { app: a, sql } = app();
    expect((await a.request(PATH, post(createDatabaseSql(ID), {}))).status).toBe(401);
    expect(
      (await a.request(PATH, post(createDatabaseSql(ID), { authorization: "Bearer nope" }))).status,
    ).toBe(401);
    expect(sql).not.toHaveBeenCalled();
  });

  test("a project it does not serve is a 404, as upstream", async () => {
    const res = await app().app.request(
      "/v1/projects/otherprojectotherpro/database/query",
      post(createDatabaseSql(ID)),
    );
    expect(res.status).toBe(404);
  });

  test("refuses a statement the platform does not send, and says why", async () => {
    // A third statement routed onto this channel has to fail LOUDLY in dev
    // rather than diverge silently from production.
    const { app: a, sql } = app();
    const res = await a.request(PATH, post("drop table users"));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("app-db-admin.ts issues");
    expect(sql).not.toHaveBeenCalled();
  });

  test("a body with no query is a 400", async () => {
    expect((await app().app.request(PATH, post(undefined))).status).toBe(400);
    expect(
      (
        await app().app.request(PATH, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: "not json",
        })
      ).status,
    ).toBe(400);
  });

  test("renders a SQL failure with its SQLSTATE, the way upstream does", async () => {
    // This is the load-bearing one: `supabase-management.ts` lifts `code` out of
    // that token, which is what makes a lost `create database` race absorb as
    // `42P04` locally exactly as it does in production.
    const duplicate = Object.assign(new Error('database "x" already exists'), { code: "42P04" });
    const sql: SqlExec = vi.fn(() => Promise.reject(duplicate));
    const res = await app(sql).app.request(PATH, post(createDatabaseSql(ID)));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("(SQLSTATE 42P04)");
  });

  test("a failure with no SQLSTATE carries no token", async () => {
    const sql: SqlExec = vi.fn(() => Promise.reject(new Error("connection terminated")));
    const res = await app(sql).app.request(PATH, post(dropDatabaseSql(ID)));
    const body = await res.text();
    expect(body).toContain("connection terminated");
    expect(body).not.toContain("SQLSTATE");
  });
});

describe("startDevManagementApi", () => {
  test("refuses a non-loopback admin URL", async () => {
    // It runs DDL as `postgres` behind a throwaway token. Pointed at a real
    // cluster that is a credential-free way to drop tenant databases — and a
    // real project has a real control plane anyway.
    await expect(
      startDevManagementApi({
        dbUrl: "postgres://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
        ref: REF,
        token: TOKEN,
        sql: vi.fn(async () => []),
      }),
    ).rejects.toThrow(/loopback-only/);
  });
});
