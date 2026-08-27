// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { appDbIdentifier } from "./app-database.ts";
import {
  appDbAdmin,
  createDatabaseSql,
  dropDatabaseSql,
  extraAppDbTargets,
  managementDatabaseAdmin,
} from "./app-db-admin.ts";
import type { SupabaseManagementApi } from "./supabase-management.ts";

const REF = "testreftestreftestre";
const ID = appDbIdentifier("my-agent");
const SUPABASE_URL = `postgres://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
const LOCAL_URL = "postgres://postgres:pw@127.0.0.1:54322/postgres";

/** A recording {@link SupabaseManagementApi}; `respond` can make one fail. */
function fakeApi(respond: (sql: string) => Promise<Record<string, unknown>[]> = async () => []) {
  const statements: string[] = [];
  const api: SupabaseManagementApi = {
    ref: REF,
    query: (sql) => {
      statements.push(sql);
      return respond(sql);
    },
  };
  return { api, statements };
}

/** Boot announcements are chatty by design; keep them out of the test output. */
function silenceBoot() {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { info, warn };
}

describe("the statement text", () => {
  test("is one `create database` and a forceful, idempotent drop", () => {
    expect(createDatabaseSql(ID)).toBe(`create database "${ID}"`);
    // `with (force)` because the app's guest normally still holds a ctx.db pool;
    // `if exists` because a deprovision is idempotent and swept concurrently.
    expect(dropDatabaseSql(ID)).toBe(`drop database if exists "${ID}" with (force)`);
  });

  test("refuses an identifier that is not `app_<16 hex>`", () => {
    // DDL cannot take bind parameters, and this text crosses a network boundary
    // to be executed as `postgres` — the shape assertion is the only guard.
    for (const bad of ['app_00"; drop database "x', "app_zz", "postgres", ""]) {
      expect(() => createDatabaseSql(bad)).toThrow(/Invalid app db identifier/);
      expect(() => dropDatabaseSql(bad)).toThrow(/Invalid app db identifier/);
    }
  });
});

describe("managementDatabaseAdmin", () => {
  test("sends create and drop to the project's query endpoint", async () => {
    const { api, statements } = fakeApi();
    const admin = managementDatabaseAdmin(api);
    await admin.createDatabase(ID);
    await admin.dropDatabase(ID);
    expect(statements).toEqual([createDatabaseSql(ID), dropDatabaseSql(ID)]);
    expect(admin.ref).toBe(REF);
  });

  test("explains a `25001` rather than repeating the SQLSTATE at the caller", async () => {
    // The control plane running the statement inside a transaction is a property
    // of the channel, not of the request: retrying cannot help, and the bare
    // SQLSTATE reads as a bug in this code.
    const { api } = fakeApi(() =>
      Promise.reject(Object.assign(new Error("in a transaction"), { code: "25001" })),
    );
    const err = await managementDatabaseAdmin(api)
      .createDatabase(ID)
      .then(
        () => null,
        (e: unknown) => e as Error & { code?: string },
      );
    expect(err?.message).toContain("transaction block");
    expect(err?.message).toContain("retrying cannot help");
    // `code` survives, so a caller's SQLSTATE check is unaffected.
    expect(err?.code).toBe("25001");
  });

  test("passes every other failure through unchanged", async () => {
    // Notably `42P04`, which `provisionAppDatabase` absorbs itself.
    const duplicate = Object.assign(new Error("already exists"), { code: "42P04" });
    const { api } = fakeApi(() => Promise.reject(duplicate));
    await expect(managementDatabaseAdmin(api).dropDatabase(ID)).rejects.toBe(duplicate);
  });
});

describe("appDbAdmin", () => {
  test("binds to the project the admin URL names", () => {
    const { info } = silenceBoot();
    const admin = appDbAdmin({ url: SUPABASE_URL, env: { SUPABASE_ACCESS_TOKEN: "sbp_t" } });
    expect(admin?.ref).toBe(REF);
    // Announced: which channel a deployment ended up on is otherwise invisible.
    expect(info.mock.calls[0]?.[0]).toContain(REF);
    expect(info.mock.calls[0]?.[0]).toContain(`db.${REF}.supabase.co`);
  });

  test("SUPABASE_PROJECT_REF wins over the derived ref", () => {
    silenceBoot();
    const admin = appDbAdmin({
      url: SUPABASE_URL,
      env: { SUPABASE_ACCESS_TOKEN: "sbp_t" },
      refOverride: "zzzzzzzzzzzzzzzzzzzz",
    });
    expect(admin?.ref).toBe("zzzzzzzzzzzzzzzzzzzz");
  });

  test("refuses an override that is not ref-shaped", () => {
    silenceBoot();
    expect(() =>
      appDbAdmin({
        url: SUPABASE_URL,
        env: { SUPABASE_ACCESS_TOKEN: "sbp_t" },
        refOverride: "https://api.supabase.com/projects/mine",
      }),
    ).toThrow(/not a Supabase project ref/);
  });

  test("refuses to boot without a token", () => {
    // There is no SQL path any more, so this is not a downgrade — it is a
    // platform database whose apps could never get one, failing at boot instead
    // of per request.
    silenceBoot();
    expect(() => appDbAdmin({ url: SUPABASE_URL, env: {} })).toThrow(/SUPABASE_ACCESS_TOKEN/);
  });

  test("refuses to boot when the token names no project", () => {
    silenceBoot();
    const boom = () => appDbAdmin({ url: LOCAL_URL, env: { SUPABASE_ACCESS_TOKEN: "sbp_t" } });
    expect(boom).toThrow(/no Supabase project ref/);
    // The message names both ways to supply one, and no fallback.
    expect(boom).toThrow(/SUPABASE_PROJECT_REF/);
    expect(boom).toThrow(/no SQL fallback/);
  });

  test("local dev without credentials has no per-app databases, out loud", () => {
    // The local stack has no control plane to call, and pointing a laptop's token
    // at a real project would create tenant databases in production from a dev
    // machine. So: off, announced, and the storage routes 503.
    const { warn } = silenceBoot();
    expect(appDbAdmin({ url: LOCAL_URL, env: { AAI_LOCAL_DEV: "1" } })).toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toContain("per-app databases are OFF");
    expect(warn.mock.calls[0]?.[0]).toContain("SUPABASE_ACCESS_TOKEN");
  });

  test("logs the host but never the admin URL's password", () => {
    const { warn } = silenceBoot();
    appDbAdmin({
      url: "postgres://postgres:admin-secret@127.0.0.1:54322/postgres",
      env: { AAI_LOCAL_DEV: "1" },
    });
    expect(warn.mock.calls[0]?.[0]).toContain("127.0.0.1");
    expect(warn.mock.calls[0]?.[0]).not.toContain("admin-secret");
  });
});

describe("extraAppDbTargets", () => {
  test("is empty without APP_DB_URLS", () => {
    expect(extraAppDbTargets({})).toEqual([]);
    expect(extraAppDbTargets({ APP_DB_URLS: " , " })).toEqual([]);
  });

  test("resolves a channel per cluster, from that cluster's own URL", () => {
    silenceBoot();
    const other = "wwwwwwwwwwwwwwwwwwww";
    const targets = extraAppDbTargets({
      SUPABASE_ACCESS_TOKEN: "sbp_t",
      APP_DB_URLS: `postgres://postgres:pw@db.${REF}.supabase.co:5432/postgres, postgres://postgres.${other}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
    });
    // A project ref is per cluster: one override could not be right for both.
    expect(targets.map((t) => t.admin.ref)).toEqual([REF, other]);
  });

  test("refuses a cluster whose channel cannot be resolved, local dev included", () => {
    // Declaring APP_DB_URLS is a deliberate production act, so the local-dev
    // "no per-app databases" arm does not apply to it.
    silenceBoot();
    expect(() => extraAppDbTargets({ AAI_LOCAL_DEV: "1", APP_DB_URLS: LOCAL_URL })).toThrow(
      /SUPABASE_ACCESS_TOKEN/,
    );
  });

  /**
   * The pooler is PER CLUSTER, and while it was per fleet sharding could not
   * work at all.
   *
   * `withPoolerHost` moves an app URL's host onto the pooler's. With one
   * `APP_DB_POOLER_URL` for the fleet, an app on an extra cluster was addressed
   * at the PRIMARY's Supavisor while `withDatabase` had correctly copied the
   * EXTRA project's tenant suffix onto its username — and Supavisor identifies
   * the tenant from that suffix. So every connection for a sharded app failed,
   * the guest's own `DATABASE_URL` included.
   */
  test("an entry carries its own pooler, and it is kept with that target", () => {
    silenceBoot();
    const pooler =
      "postgres://postgres.wwwwwwwwwwwwwwwwwwww:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
    const [target] = extraAppDbTargets({
      SUPABASE_ACCESS_TOKEN: "sbp_t",
      APP_DB_URLS: `${SUPABASE_URL}|${pooler}`,
    });
    expect(target?.url).toBe(SUPABASE_URL);
    expect(target?.poolerUrl).toBe(pooler);
    // The channel still comes from the ADMIN half, not the pooler half.
    expect(target?.admin.ref).toBe(REF);
  });

  test("an entry with no pooler is direct to that cluster", () => {
    silenceBoot();
    const [target] = extraAppDbTargets({
      SUPABASE_ACCESS_TOKEN: "sbp_t",
      APP_DB_URLS: SUPABASE_URL,
    });
    expect(target?.poolerUrl).toBeUndefined();
  });

  test("a per-cluster pooler is held to the same two rules as the primary's", () => {
    silenceBoot();
    // Transaction mode: breaks graphile-worker's prepared statements and
    // world-postgres's LISTEN, silently — the queue appears to work and every
    // parked run stops resuming.
    expect(() =>
      extraAppDbTargets({
        SUPABASE_ACCESS_TOKEN: "sbp_t",
        APP_DB_URLS: `${SUPABASE_URL}|postgres://postgres.w:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      }),
    ).toThrow();
    // And Supabase's DIRECT host is not a pooler, whatever port it is given.
    expect(() =>
      extraAppDbTargets({
        SUPABASE_ACCESS_TOKEN: "sbp_t",
        APP_DB_URLS: `${SUPABASE_URL}|${SUPABASE_URL}`,
      }),
    ).toThrow();
  });

  test("a malformed entry is REFUSED rather than half-read", () => {
    silenceBoot();
    // Two separators is a typo, and ignoring the tail is how it reaches
    // production addressed at the wrong host.
    expect(() =>
      extraAppDbTargets({ SUPABASE_ACCESS_TOKEN: "sbp_t", APP_DB_URLS: `${SUPABASE_URL}|a|b` }),
    ).toThrow(/separators/);
    expect(() =>
      extraAppDbTargets({ SUPABASE_ACCESS_TOKEN: "sbp_t", APP_DB_URLS: "|only-a-pooler" }),
    ).toThrow(/no admin URL/);
  });
});
