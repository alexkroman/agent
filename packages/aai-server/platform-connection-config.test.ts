// Copyright 2026 the AAI authors. MIT license.
/**
 * The three connection settings per-app databases introduced, and the rules each
 * one refuses to bend.
 *
 * They are grouped because they are one decision seen from three sides — WHICH
 * connection may be pooled, and in which mode — and that decision is measured
 * rather than assumed:
 *
 * - the SLUG-LOCK pool must be direct (a session-scoped `pg_advisory_lock` really
 *   does lose exclusion through a transaction pooler),
 * - the ADMIN pool must be TRANSACTION-pooled (that is the only mode that
 *   multiplexes, and `pg_try_advisory_xact_lock` survives it),
 * - app databases must be SESSION-pooled (graphile-worker's prepared statements
 *   and `world-postgres`'s `LISTEN` both break under transaction mode).
 *
 * `supabase/config.toml`'s pooler stanza carries the measurements.
 */

import { describe, expect, test } from "vitest";
import { appDbPoolerUrl, platformDbDsn, platformPoolerUrl } from "./platform-connection-config.ts";

const ADMIN = "postgresql://postgres:s3cret@db.abcdefgh.supabase.co:5432/postgres";

describe("platformDbDsn", () => {
  test("builds a libpq DSN from the admin URL", () => {
    const built = platformDbDsn(ADMIN);
    expect(built).toEqual({
      dsn: "dbname='postgres' user='postgres' password='s3cret' host='db.abcdefgh.supabase.co' port='5432'",
    });
  });

  test("an override carrying a PORT replaces both, never just the host", () => {
    // THE bug this test exists for. A remapped host almost always means a
    // remapped port: taking the host from the override and the port from the
    // admin URL produced `host=db port=54322` — the in-container NAME beside the
    // host-published PORT, which nothing is listening on. It shipped that way
    // first and the DSN could not connect at all.
    const built = platformDbDsn("postgresql://postgres:pw@127.0.0.1:54322/postgres", "db:5432");
    expect(built).toEqual({
      dsn: "dbname='postgres' user='postgres' password='pw' host='db' port='5432'",
    });
  });

  test("a bare host override keeps the admin URL's port", () => {
    const built = platformDbDsn(ADMIN, "db.internal");
    expect(built).toMatchObject({
      dsn: expect.stringContaining("host='db.internal' port='5432'"),
    });
  });

  test("a LOOPBACK host is refused, with the remedy in the message", () => {
    // pg_cron's worker connects over loopback, which matches a `trust` rule — and
    // dblink refuses a non-superuser connection whose password was never used
    // (2F003). Refused rather than attempted, because the failure surfaces once an
    // hour inside a guarded job body: a sweep that reclaims nothing, silently.
    // `[::1]` bracketed, because that is the only spelling `new URL` accepts —
    // and `url.hostname` gives it back WITH the brackets, which is why the
    // loopback set carries both forms.
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const built = platformDbDsn(`postgresql://postgres:pw@${host}:5432/postgres`);
      expect(built).toHaveProperty("reason");
      expect("reason" in built && built.reason).toMatch(/AAI_DBLINK_HOST/);
    }
  });

  test("an override rescues a loopback admin URL", () => {
    expect(
      platformDbDsn("postgresql://postgres:pw@127.0.0.1:54322/postgres", "db:5432"),
    ).toHaveProperty("dsn");
  });

  test("an override that is ITSELF loopback is still refused", () => {
    expect(platformDbDsn(ADMIN, "127.0.0.1:5432")).toHaveProperty("reason");
  });

  test("a password-less URL is refused rather than yielding an unusable DSN", () => {
    // dblink's whole requirement is that the password is really used; a DSN
    // without one produces the 2F003 this function exists to pre-empt.
    expect(platformDbDsn("postgresql://postgres@db.example.com:5432/postgres")).toHaveProperty(
      "reason",
    );
  });

  test("a password with a quote or backslash cannot break out of its field", () => {
    // libpq keyword/value quoting, so a generated admin password containing either
    // stays one field rather than becoming syntax.
    const built = platformDbDsn("postgresql://postgres:a%27b%5Cc@db.example.com:5432/postgres");
    expect(built).toMatchObject({ dsn: expect.stringContaining("password='a\\'b\\\\c'") });
  });

  test("a non-URL is reported, not thrown", () => {
    expect(platformDbDsn("not a url")).toEqual({ reason: "SUPABASE_DB_URL is not a URL" });
  });
});

describe("platformPoolerUrl", () => {
  test("unset means direct — the budget then understates, and boot says so", () => {
    expect(platformPoolerUrl({})).toBeUndefined();
    expect(platformPoolerUrl({ PLATFORM_POOLER_URL: "  " })).toBeUndefined();
  });

  test("accepts a transaction-mode URL by port or by explicit declaration", () => {
    const byPort = "postgresql://postgres.ref:pw@pooler.supabase.com:6543/postgres";
    expect(platformPoolerUrl({ PLATFORM_POOLER_URL: byPort })).toBe(byPort);
    // The declaration is what a REMAPPED port needs: the local stack publishes
    // Supavisor on `[db.pooler].port` (54329), so the port says nothing about the
    // mode once it has been forwarded. This was a real boot failure.
    const declared = "postgresql://postgres.pooler-dev:pw@127.0.0.1:54329/postgres?pgbouncer=true";
    expect(platformPoolerUrl({ PLATFORM_POOLER_URL: declared })).toBe(declared);
  });

  test("REFUSES a session-mode URL, because it would multiplex nothing", () => {
    // Backwards-looking until you see what it prevents: a session-mode pooler
    // holds one server connection per client connection, so it looks configured
    // while saving nothing — and the connection budget counts on the saving.
    expect(() =>
      platformPoolerUrl({
        PLATFORM_POOLER_URL: "postgresql://postgres.ref:pw@pooler.supabase.com:5432/postgres",
      }),
    ).toThrow(/TRANSACTION-mode/);
  });
});

describe("appDbPoolerUrl", () => {
  test("unset means direct", () => {
    expect(appDbPoolerUrl({})).toBeUndefined();
  });

  test("accepts session mode, and REFUSES transaction mode", () => {
    const session = "postgresql://postgres.ref:pw@pooler.supabase.com:5432/postgres";
    expect(appDbPoolerUrl({ APP_DB_POOLER_URL: session })).toBe(session);
    // The opposite refusal from `platformPoolerUrl`, and both are forced. An app
    // database hosts the Workflow DevKit: graphile-worker uses NAMED prepared
    // statements, `world-postgres` opens a `LISTEN` client with no polling
    // fallback, and `workflow-lock-sweep.ts` takes a SESSION-scoped advisory lock.
    // Transaction mode breaks all three, and silently.
    expect(() =>
      appDbPoolerUrl({
        APP_DB_POOLER_URL: "postgresql://postgres.ref:pw@pooler.supabase.com:6543/postgres",
      }),
    ).toThrow();
  });
});
