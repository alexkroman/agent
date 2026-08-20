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
import { appDbPoolerUrl, platformPoolerUrl } from "./platform-connection-config.ts";

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
