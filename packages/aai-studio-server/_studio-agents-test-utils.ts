// Copyright 2026 the AAI authors. MIT license.
/**
 * The two doubles every project-level suite needs: an OWNED deployed agent,
 * and the app-database provisioner.
 *
 * Both were written three times over (studio-database.test.ts,
 * studio-database-routes.test.ts, studio-secrets.test.ts) and the copies had
 * DRIFTED. One `fakeAppDb` minted a fresh password per call — deliberately,
 * since re-provisioning an enabled slug rotates the password a live sandbox is
 * holding, and "never re-provision" is the property its suite exists to pin —
 * while the other returned a constant, so the same call meant different things
 * in the two files. The role differed too: `appDbIdentifier(slug)` against a
 * hand-rolled `app_…` slice of it.
 *
 * `aai-server`'s `deployAgent` cannot serve as the claim helper: a project owns
 * TWO agents and `POST /deploy` refuses the `-preview` suffix for everyone but
 * the auto-preview deployer, so these suites have to claim at the store.
 */

import { type AppDatabases, type AppDbMeta, appDbIdentifier } from "aai-server/app-database";
import type { SqlExec } from "aai-server/secret-store";
import { hashApiKey } from "aai-server/secrets";
import type { BundleStore } from "aai-server/store-types";
import { fakeAppDatabases } from "aai-server/test-utils";
import { vi } from "vitest";

/** Deploy `slug` owned by `key` — what makes `verifySlugOwner` say "owned". */
export function claimSlug(store: BundleStore, slug: string, key: string): Promise<void> {
  return store.putAgent({
    slug,
    env: {},
    worker: "export default {}",
    clientFiles: {},
    credential_hashes: [hashApiKey(key)],
  });
}

export type FakeAppDb = AppDatabases & {
  provision: ReturnType<typeof vi.fn>;
  deprovision: ReturnType<typeof vi.fn>;
};

/**
 * What a fake app database ANSWERS when something reads it.
 *
 * A `SqlExec` over the app's own database, which is what `withAppDb` hands its
 * caller — the seam the studio's table viewer goes through
 * (`studio-database-browse.ts`). Declared here so a suite that needs one says
 * what the tenant's Postgres replies and nothing else: the alternative was
 * `{ ...fakeAppDb(), withAppDb } as unknown as FakeAppDb` at the call site,
 * and a cast stops reporting the moment `AppDatabases` grows a method.
 */
export type FakeAppDbReads = (query: string, params?: unknown[]) => Record<string, unknown>[];

/**
 * Provisioning that records its calls and mints a per-slug meta.
 *
 * With `reads`, the app's own database answers them through `withAppDb`.
 * Without, that method is left UNSTUBBED — `fakeAppDatabases` throws naming
 * it, which is what stops a suite silently reading an empty tenant database
 * and concluding the agent stored nothing.
 */
export function fakeAppDb(reads?: FakeAppDbReads): FakeAppDb {
  let issued = 0;
  const provisioning: Partial<AppDatabases> = {
    provision: vi.fn(async (slug: string): Promise<AppDbMeta> => {
      // A FRESH password per call — the real provisioner rotates, which is
      // exactly why an enabled slug must never be re-provisioned. Counted
      // rather than random: a test double has no business being
      // nondeterministic, and a constant would make that property unpinnable.
      issued += 1;
      return { role: appDbIdentifier(slug), password: `pw${issued}`.padEnd(32, "0") };
    }),
    deprovision: vi.fn(async () => undefined),
    // The app's own database in the path — see app-database.ts on why a schema
    // could not host the Workflow DevKit.
    connectionUrl: (meta) => `postgres://app@db/${meta.role}`,
    usage: async () => ({ tables: 0, rows: 0, bytes: 0 }),
  };
  if (reads !== undefined) {
    provisioning.withAppDb = <T>(_meta: AppDbMeta, fn: (sql: SqlExec) => Promise<T>): Promise<T> =>
      fn(async (query, params) => reads(query, params));
  }
  return fakeAppDatabases(provisioning) as FakeAppDb;
}
