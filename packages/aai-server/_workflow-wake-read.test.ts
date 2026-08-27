// Copyright 2026 the AAI authors. MIT license.
/**
 * The READ half of the wake sweep, where its behaviour depends on WHICH cluster
 * an app lives on.
 *
 * Split from `workflow-wake.test.ts` when it went over the test line cap, along
 * the seam the source already has: that file drives the sweep's POLICY through a
 * faked `withAppDb`, and this one exercises the real `createAppDatabases`
 * underneath it — which is the only layer that can answer a question about
 * cluster resolution at all.
 */

import { describe, expect, test } from "vitest";
import { readDueWork } from "./_workflow-wake-read.ts";
import { appDbIdentifier, createAppDatabases } from "./app-database.ts";
import type { AdminDb } from "./platform-lock.ts";
import { APP_DB_SECRET_PREFIX } from "./secret-store.ts";
import { createTestStore, fakeAdminDbOver, fakeDatabaseAdmin } from "./test-utils.ts";

/** An agents store listing exactly `slugs` — the deleted-agent guard's input. */
function storeWithSlugs(slugs: string[]) {
  const store = createTestStore();
  return Object.assign(store, { listSlugs: async () => slugs });
}

/**
 * The claim `workflow-wake.ts`'s module doc makes about placement clusters, and
 * the reason it needs a test rather than a paragraph.
 *
 * That doc used to record the opposite as a known gap — "apps placed on an extra
 * `APP_DB_URLS` cluster are not swept" — and boot warned about it, which is why
 * there were none in production. It was never true: every step of the pass is
 * either cluster-INDEPENDENT (the Vault read and the agents-table enumeration
 * are both on the platform database) or follows the app's own locator (the
 * per-app read goes through `AppDatabases.withAppDb`).
 *
 * Asserted against the REAL `createAppDatabases` rather than the
 * `fakeWakeAppDb` above, deliberately: that fake implements `withAppDb` itself,
 * so it is exactly the layer whose cluster resolution is in question, and a test
 * built on it would confirm the claim by assuming it. What is faked here is only
 * the opener, which is what records the URL the read really dialled.
 */
describe("the read phase across placement clusters", () => {
  const SECONDARY = "postgres://postgres.bbbbbbbbbbbbbbbbbbbb:pw@cluster-b.example:5432/postgres";

  /** An `AdminDb` whose Vault rows carry a LOCATOR naming the extra cluster. */
  function adminDbOnSecondary(slug: string): AdminDb {
    return fakeAdminDbOver((sql) => {
      if (sql.includes("pg_try_advisory_xact_lock")) return [{ locked: true }];
      if (sql.includes("to_regclass('vault.secrets')")) return [{ present: true }];
      if (sql.includes("vault.decrypted_secrets")) {
        return [
          {
            name: `${APP_DB_SECRET_PREFIX}${slug}`,
            decrypted_secret: JSON.stringify({
              role: appDbIdentifier(slug),
              password: "0".repeat(32),
              url: SECONDARY,
            }),
          },
        ];
      }
      return [];
    });
  }

  test("reads an app on an extra cluster, through that cluster's own pooler", async () => {
    const urls: string[] = [];
    const appDb = createAppDatabases({
      url: "postgres://postgres.aaaaaaaaaaaaaaaaaaaa:pw@primary.example:5432/postgres",
      sql: async () => [],
      open: (url) => {
        urls.push(url);
        return {
          // Present, and due: the hint read is two statements and this answers
          // both, so the pass reaches a real verdict rather than an empty one.
          query: async (query: string) =>
            query.includes("to_regclass")
              ? [{ present: true }]
              : [{ wake_at: new Date("2026-01-01T00:00:00Z") }],
          close: async () => undefined,
        };
      },
      admin: fakeDatabaseAdmin("aaaaaaaaaaaaaaaaaaaa"),
      poolerUrl: "postgres://postgres:pw@pooler-primary.example:5432/postgres",
      extraTargets: [
        {
          url: SECONDARY,
          sql: async () => [],
          admin: fakeDatabaseAdmin("bbbbbbbbbbbbbbbbbbbb"),
          poolerUrl: "postgres://postgres:pw@pooler-b.example:5432/postgres",
        },
      ],
    });

    const due = await readDueWork({
      adminDb: adminDbOnSecondary("slug-a"),
      store: storeWithSlugs(["slug-a"]),
      appDb,
      readTimeoutMs: 5000,
      readConcurrency: 4,
    });

    // The app IS swept — a candidate, and due.
    expect(due.locked).toBe(true);
    expect(due.candidates).toBe(1);
    expect(due.due).toEqual(["slug-a"]);
    // And it was dialled on its OWN cluster's pooler. Before the per-cluster
    // pooler this was `pooler-primary.example`, where the read could only fail:
    // the username carries the extra project's tenant suffix, which the
    // primary's Supavisor does not know.
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? "").hostname).toBe("pooler-b.example");
  });
});
