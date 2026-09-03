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
import { announceDirectDbHost, platformPoolerUrl } from "./platform-connection-config.ts";
import { captureLogs } from "./test-utils.ts";

/** Supabase's direct endpoint, and Supavisor's — the pair every rule here sorts. */
const DIRECT = "postgresql://postgres:pw@db.abcdefghijklmno.supabase.co";
const POOLER = "postgresql://postgres.abcdefghijklmno:pw@aws-0-us-east-2.pooler.supabase.com";

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

  test("REFUSES Supabase's DIRECT host, whatever port it wears", () => {
    // The production outage: the direct connection string with its port changed
    // to 6543 is MODE-valid and reaches nothing, because that host has no A
    // record without the IPv4 add-on. It took the admin pool — agents rows,
    // Vault, workspaces, chats, pg_cron, the capacity read, the wake sweep — to
    // `getaddrinfo ENOTFOUND` while /health kept answering 200.
    expect(() => platformPoolerUrl({ PLATFORM_POOLER_URL: `${DIRECT}:6543/postgres` })).toThrow(
      /DIRECT endpoint/,
    );
    // And with the mode DECLARED rather than implied by the port, which is the
    // spelling that also slips past the mode check.
    expect(() =>
      platformPoolerUrl({ PLATFORM_POOLER_URL: `${DIRECT}:5432/postgres?pgbouncer=true` }),
    ).toThrow(/DIRECT endpoint/);
  });

  test("accepts the pooler host and the direct host SHARING a hostname is not the test", () => {
    // Deliberately NOT "the pooler must differ from SUPABASE_DB_URL's host":
    // production's correct pair is the same Supavisor hostname on two ports, and
    // the local stack puts Supavisor and Postgres both on 127.0.0.1. Hostname
    // equality does not separate the working config from the broken one.
    const both = {
      SUPABASE_DB_URL: `${POOLER}:5432/postgres`,
      PLATFORM_POOLER_URL: `${POOLER}:6543/postgres`,
    };
    expect(platformPoolerUrl(both)).toBe(both.PLATFORM_POOLER_URL);
  });

  test("judges nothing about a self-hosted or forwarded pooler", () => {
    // The rule is scoped to Supabase-managed hostnames: a loopback forward, a
    // proxy, or a self-hosted Supavisor has no `db.<ref>.supabase.co` shape to
    // recognize, and guessing at one would refuse a legitimate deployment.
    const local = "postgresql://postgres.pooler-dev:pw@127.0.0.1:54329/postgres?pgbouncer=true";
    expect(platformPoolerUrl({ PLATFORM_POOLER_URL: local })).toBe(local);
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

describe("announceDirectDbHost", () => {
  const logs = captureLogs();

  test("WARNS on the direct host rather than refusing it", () => {
    // Warned, not refused: a direct session-mode connection is correct on a
    // project with the IPv4 add-on, and only unreachable on this deployment —
    // which no string can tell. The refusal above is for the pooler vars, where
    // the value can never be right.
    announceDirectDbHost({ SUPABASE_DB_URL: `${DIRECT}:5432/postgres` });
    expect(logs.warns()).toEqual([expect.stringContaining("DIRECT host")]);
    expect(logs.warns()[0]).toContain("db.abcdefghijklmno.supabase.co");
  });

  test("says nothing about a pooler host, an unset var, or an unparsable one", () => {
    announceDirectDbHost({ SUPABASE_DB_URL: `${POOLER}:5432/postgres` });
    announceDirectDbHost({});
    announceDirectDbHost({ SUPABASE_DB_URL: "not a url" });
    expect(logs.all()).toEqual([]);
  });
});
