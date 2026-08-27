// Copyright 2026 the AAI authors. MIT license.
/**
 * The app-database ENTITLEMENT concern: each tier's limit, and the one statement
 * that moves a live role between them.
 *
 * Split from `app-database.test.ts` when it went over the test line cap, along
 * the same seam `app-db-tier.ts` was split from `app-database.ts` — that file
 * covers what a database IS, this covers what its role is entitled to.
 */

import { describe, expect, test, vi } from "vitest";
import { appDbIdentifier, createAppDatabases } from "./app-database.ts";
import type { DatabaseAdmin } from "./app-db-admin.ts";
import { reconcileAppDbConnectionLimit } from "./app-db-tier.ts";
import type { SqlExec } from "./secret-store.ts";

/** Records every statement; `respond` decides what a read answers. */
function captureSql(respond: (query: string) => Record<string, unknown>[] = () => []) {
  const calls: { query: string; params?: unknown[] | undefined }[] = [];
  const sql: SqlExec = vi.fn(async (query, params) => {
    calls.push({ query, params });
    return respond(query);
  });
  return { sql, calls };
}

function fakeDatabaseAdmin(ref = "aaaaaaaaaaaaaaaaaaaa"): DatabaseAdmin {
  return { ref, createDatabase: async () => undefined, dropDatabase: async () => undefined };
}

function captureOpener() {
  const open = () => ({ query: async () => [], close: async () => undefined });
  return { open };
}

describe("createAppDatabases tiering", () => {
  /**
   * A tier change runs on the cluster the app's locator names, for the same
   * reason a deprovision does: role attributes are CLUSTER-level, so an `alter
   * role` aimed at the wrong project silently alters nothing (or, worse,
   * something else's role of the same name).
   */
  test("reconcileTier alters the role on the app's own cluster", async () => {
    const primary = captureSql();
    const secondaryUrl = "postgres://postgres:pw@cluster-b.example:5432/postgres";
    const secondary = captureSql((query) =>
      query.includes("rolconnlimit") ? [{ rolconnlimit: 10 }] : [],
    );
    const appDb = createAppDatabases({
      url: "postgres://postgres:pw@primary.example:5432/postgres",
      sql: primary.sql,
      open: captureOpener().open,
      admin: fakeDatabaseAdmin("aaaaaaaaaaaaaaaaaaaa"),
      extraTargets: [
        { url: secondaryUrl, sql: secondary.sql, admin: fakeDatabaseAdmin("bbbbbbbbbbbbbbbbbbbb") },
      ],
    });

    const result = await appDb.reconcileTier(
      "slug-a",
      { role: appDbIdentifier("slug-a"), password: "0".repeat(32), url: secondaryUrl },
      "storage",
    );

    expect(result.changed).toBe(true);
    expect(secondary.calls.some((c) => c.query.includes("connection limit 4"))).toBe(true);
    expect(primary.calls).toEqual([]);
  });
});

describe("reconcileAppDbConnectionLimit", () => {
  /** The role already at the target limit: no write, and nothing to rebuild. */
  test("is a no-op when the limit already matches", async () => {
    const { sql, calls } = captureSql(() => [{ rolconnlimit: 4 }]);
    const result = await reconcileAppDbConnectionLimit(sql, "slug-a", "storage");
    expect(result).toEqual({ changed: false, limit: 4 });
    expect(calls.filter((c) => c.query.includes("alter role"))).toEqual([]);
  });

  test("raises a storage-tier role to the workflow limit", async () => {
    const { sql, calls } = captureSql(() => [{ rolconnlimit: 4 }]);
    const result = await reconcileAppDbConnectionLimit(sql, "slug-a", "workflow");
    expect(result).toEqual({ changed: true, limit: 10 });
    expect(calls.at(-1)?.query).toBe(
      `alter role "${appDbIdentifier("slug-a")}" connection limit 10`,
    );
  });

  /**
   * The password is what a resident guest is holding, so this statement must
   * never touch it — that is the whole reason a tier change can ride the
   * idempotent `enableStorage` path where a re-provision cannot.
   */
  test("never touches the password or the login attribute", async () => {
    const { sql, calls } = captureSql(() => [{ rolconnlimit: 10 }]);
    await reconcileAppDbConnectionLimit(sql, "slug-a", "storage");
    const written = calls.map((c) => c.query).join("\n");
    expect(written).not.toMatch(/password/i);
    expect(written).not.toMatch(/\blogin\b/i);
  });

  /**
   * A role the catalog does not list is a half-deprovisioned app, and
   * `provision` is what repairs one — reporting no change here leaves the
   * caller's own idempotence to decide, rather than failing a request over a
   * database that may not exist.
   */
  test("reports no change for a role the catalog does not list", async () => {
    const { sql, calls } = captureSql(() => []);
    const result = await reconcileAppDbConnectionLimit(sql, "slug-a", "storage");
    expect(result).toEqual({ changed: false, limit: 4 });
    expect(calls.filter((c) => c.query.includes("alter role"))).toEqual([]);
  });
});
