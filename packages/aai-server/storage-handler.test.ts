// Copyright 2026 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { expect, test, vi } from "vitest";
import type { AppDatabases, AppDbMeta } from "./app-database.ts";
import type { AppDbTier } from "./app-db-tier.ts";
import { createMemorySecretStore, type SecretStore } from "./secret-store.ts";
import {
  authFetch,
  createTestOrchestrator,
  deployAgent,
  fakeAppDatabases,
  type TestFetch,
} from "./test-utils.ts";

// Carries a `url`, because that locator is the point of the two deprovision
// assertions below: it names the cluster this app was placed on, and a
// deprovision that recomputes placement instead of reading it drops on the
// wrong cluster after any change to APP_DB_URLS.
const META: AppDbMeta = {
  role: "app_0123456789abcdef",
  password: "f".repeat(32),
  url: "postgres://postgres:pw@cluster-b.example:5432/postgres",
  // The tier a provision RECORDS, and the default one at that: it is what a
  // later enable compares against to decide whether the role's connection limit
  // has to be reconciled.
  tier: "workflow",
};

function fakeAppDb(): AppDatabases & {
  provision: ReturnType<typeof vi.fn>;
  deprovision: ReturnType<typeof vi.fn>;
} {
  return fakeAppDatabases({
    // ECHOES the tier, as `provisionAppDatabase` does — the returned meta is
    // what the caller persists, so a fake that dropped it would make every
    // assertion about a STORED tier vacuous.
    provision: vi.fn(async (_slug: string, tier?: AppDbTier) => ({
      ...META,
      ...omitUndefined({ tier }),
    })),
    deprovision: vi.fn(async () => undefined),
    usage: async () => ({ tables: 0, rows: 0, bytes: 0 }),
  }) as AppDatabases & {
    provision: ReturnType<typeof vi.fn>;
    deprovision: ReturnType<typeof vi.fn>;
  };
}

async function deployWithStorage(opts: { appDb?: AppDatabases; secrets?: SecretStore } = {}) {
  const secrets = opts.secrets ?? createMemorySecretStore();
  const orch = await createTestOrchestrator({ secrets, ...omitUndefined({ appDb: opts.appDb }) });
  await deployAgent(orch.fetch, "my-agent", "key1");
  return { ...orch, secrets };
}

/** Owner-auth'd request to the storage route of the agent every spec deploys. */
function storageReq(fetch: TestFetch, method: string, key = "key1"): Promise<Response> {
  return authFetch(fetch, "/my-agent/storage", { method, key });
}

/**
 * `POST /:slug/storage` carrying an explicit tier.
 *
 * The body is handed to `authFetch` as an OBJECT — it stringifies and sets the
 * JSON content type itself. Pre-stringifying it here double-encoded the body
 * into a JSON *string*, which `isRecord` rejects, so the route fell back to the
 * default tier and two of these specs passed while asserting nothing.
 */
function tierReq(fetch: TestFetch, tier: unknown): Promise<Response> {
  return authFetch(fetch, "/my-agent/storage", { method: "POST", body: { tier } });
}

test("storage status rejects without auth", async () => {
  const { fetch } = await deployWithStorage();
  expect((await fetch("/my-agent/storage")).status).toBe(401);
});

test("storage status is disabled by default", async () => {
  const { fetch } = await deployWithStorage();
  const res = await storageReq(fetch, "GET");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ enabled: false });
});

test("storage enable returns 503 when SUPABASE_DB_URL is unconfigured", async () => {
  const { fetch } = await deployWithStorage(); // no appDb binding
  const res = await storageReq(fetch, "POST");
  expect(res.status).toBe(503);
  expect(await res.text()).toContain("SUPABASE_DB_URL");
});

test("storage enable provisions, stores credentials, and reports enabled", async () => {
  const appDb = fakeAppDb();
  const { fetch, secrets } = await deployWithStorage({ appDb });

  const res = await storageReq(fetch, "POST");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, enabled: true });
  // The tier reaches `provision`, and an unflagged request means the default.
  expect(appDb.provision).toHaveBeenCalledWith("my-agent", "workflow");
  expect(JSON.parse((await secrets.get("app-db:my-agent")) ?? "")).toEqual(META);

  const status = await storageReq(fetch, "GET");
  expect(await status.json()).toEqual({ enabled: true });
});

test("enabling an already-enabled app does not rotate the running guest's password", async () => {
  // `provision` mints a fresh password every call and the caller persists it,
  // so a second enable used to invalidate the `DATABASE_URL` baked into the
  // resident sandbox at spawn — `ctx.db` starts erroring mid-session, and
  // nothing here restarts a sandbox for a storage change. `aai storage enable`
  // run twice was the whole reproduction.
  const appDb = fakeAppDb();
  const { fetch, secrets } = await deployWithStorage({ appDb });

  await storageReq(fetch, "POST");
  const stored = await secrets.get("app-db:my-agent");
  appDb.provision.mockResolvedValue({ ...META, password: "0".repeat(32) });

  const again = await storageReq(fetch, "POST");
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ ok: true, enabled: true });
  expect(appDb.provision).toHaveBeenCalledTimes(1);
  await expect(secrets.get("app-db:my-agent")).resolves.toBe(stored);
});

test("storage disable deprovisions, deletes credentials, and reports disabled", async () => {
  const appDb = fakeAppDb();
  const { fetch, secrets } = await deployWithStorage({ appDb });
  await storageReq(fetch, "POST");

  const res = await storageReq(fetch, "DELETE");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, enabled: false });
  // The stored locator reaches deprovision — read BEFORE the secret holding
  // it is deleted on the next line.
  expect(appDb.deprovision).toHaveBeenCalledWith("my-agent", META);
  expect(await secrets.get("app-db:my-agent")).toBeNull();

  const status = await storageReq(fetch, "GET");
  expect(await status.json()).toEqual({ enabled: false });
});

// `test.each` rather than a loop over the verbs: the reporter names the method
// that failed, where a loop reports one test and leaves which of the three it
// was to the line number.
test.each(["GET", "POST", "DELETE"])("storage %s rejects a non-owner key", async (method) => {
  const appDb = fakeAppDb();
  const { fetch } = await deployWithStorage({ appDb });

  const res = await storageReq(fetch, method, "intruder-key");

  // 404, not 403: a non-owner is told nothing about whether the slug exists
  // (see requireOwner in middleware.ts).
  expect(res.status).toBe(404);
  // Refused BEFORE the handler ran — a rejection that had already provisioned
  // would be a leak rather than a rejection.
  expect(appDb.provision).not.toHaveBeenCalled();
});

test("enabling bumps the agent's version, so the running guest is rebuilt with a DATABASE_URL", async () => {
  // `DATABASE_URL` is composed when a sandbox is BUILT (sandbox-resolve.ts) and
  // the version is the only cross-replica invalidation signal
  // (sandbox-invalidate.ts), so without this bump the resident guest keeps the
  // env it was spawned with: `ctx.db` throws and a workflow upload refuses with
  // "Workflow uploads need a database" on an app whose Database pane says it
  // has one.
  const appDb = fakeAppDb();
  const { fetch, store } = await deployWithStorage({ appDb });
  const before = await store.getAgentVersion("my-agent");

  await storageReq(fetch, "POST");

  expect(await store.getAgentVersion("my-agent")).toBe((before ?? 0) + 1);
});

test("the bump reaches the agents change stream, which is what moves a sandbox", async () => {
  // The bump on its own is a row write; what rebuilds the guest is the event
  // every replica reacts to (`watchAgentInvalidation`). `withAgentEvents` has
  // to wrap `touch` for that, and a mutator missing from that wrapper is
  // invisible in production and silent in dev.
  const appDb = fakeAppDb();
  const { fetch, events } = await deployWithStorage({ appDb });
  const seen: string[] = [];
  events.watchAgents((slug) => void seen.push(slug));

  await storageReq(fetch, "POST");

  expect(seen).toContain("my-agent");
});

test("a no-op enable bumps nothing", async () => {
  // The skip above it is what keeps a re-enable from rotating a live
  // credential; a bump here would rebuild a healthy sandbox for a call that
  // changed nothing.
  const appDb = fakeAppDb();
  const { fetch, store } = await deployWithStorage({ appDb });
  await storageReq(fetch, "POST");
  const after = await store.getAgentVersion("my-agent");

  await storageReq(fetch, "POST");

  expect(await store.getAgentVersion("my-agent")).toBe(after);
});

test("disabling bumps too, so no guest keeps a URL to a dropped database", async () => {
  const appDb = fakeAppDb();
  const { fetch, store } = await deployWithStorage({ appDb });
  await storageReq(fetch, "POST");
  const enabled = await store.getAgentVersion("my-agent");

  await storageReq(fetch, "DELETE");

  expect(await store.getAgentVersion("my-agent")).toBe((enabled ?? 0) + 1);
});

test("agent delete deprovisions the app database and clears its credentials", async () => {
  const appDb = fakeAppDb();
  const { fetch, secrets } = await deployWithStorage({ appDb });
  await storageReq(fetch, "POST");

  const res = await authFetch(fetch, "/my-agent", { method: "DELETE" });
  expect(res.status).toBe(200);
  // Same locator rule as disable, and the ordering is tighter here: the delete
  // path's own `store.deleteAgent` sweeps `app-db:<slug>`, so the read has to
  // happen ahead of it or there is no locator left to read.
  expect(appDb.deprovision).toHaveBeenCalledWith("my-agent", META);
  // The credential secret goes too (via handleDelete → store.deleteAgent for
  // the real store; the orchestrator's secret store is authoritative here).
  expect(await secrets.get("app-db:my-agent")).toBeNull();
});

test("an explicit tier reaches provision", async () => {
  const appDb = fakeAppDb();
  const { fetch, secrets } = await deployWithStorage({ appDb });

  expect((await tierReq(fetch, "storage")).status).toBe(200);
  expect(appDb.provision).toHaveBeenCalledWith("my-agent", "storage");
  // And it is RECORDED, because the stored tier is what a later enable compares
  // against to decide whether anything has to be reconciled.
  expect(JSON.parse((await secrets.get("app-db:my-agent")) ?? "")).toMatchObject({
    tier: "storage",
  });
});

/**
 * A body is optional and a bad one is not an error — this route took none until
 * tiers existed, so every released `aai storage enable` and the studio (which
 * calls the core function directly) send nothing at all. A strict parse would
 * turn a working command into a 400 on upgrade, and an unrecognised tier can
 * only ever mean the default, which is what every app already has.
 */
test.each([
  ["no body at all", undefined],
  ["an unrecognised tier", "enormous"],
  ["a non-string tier", 7],
])("%s provisions at the default tier", async (_label, tier) => {
  const appDb = fakeAppDb();
  const { fetch } = await deployWithStorage({ appDb });

  const res = tier === undefined ? await storageReq(fetch, "POST") : await tierReq(fetch, tier);
  expect(res.status).toBe(200);
  expect(appDb.provision).toHaveBeenCalledWith("my-agent", "workflow");
});

/**
 * The tier change an app that ADDS workflows needs, and the one mutation on a
 * live app database that may not rotate its credential.
 *
 * A re-provision is what the idempotent branch exists to prevent (the test above
 * this one is the reproduction), so raising a limit cannot ride on one. `alter
 * role … connection limit` touches neither password nor login, so it rides here
 * instead — and the stored meta is updated so a third enable is a no-op.
 */
test("a tier change on an enabled app reconciles the limit without re-provisioning", async () => {
  const appDb = fakeAppDb();
  const reconcileTier = vi.fn(async () => ({ changed: true }));
  const withTier = fakeAppDatabases({
    provision: appDb.provision,
    deprovision: appDb.deprovision,
    reconcileTier,
    withAppDb: (_meta, fn) => fn(async () => []),
  });
  const { fetch, secrets } = await deployWithStorage({ appDb: withTier });

  await tierReq(fetch, "storage");
  const afterFirst = await secrets.get("app-db:my-agent");

  const again = await tierReq(fetch, "workflow");
  expect(again.status).toBe(200);
  // Handed the meta as STORED — tier `storage`, the app's state before this
  // call — because that meta's `url` is the locator deciding which cluster the
  // `alter role` runs on.
  expect(reconcileTier).toHaveBeenCalledWith("my-agent", { ...META, tier: "storage" }, "workflow");
  // Provisioned once, so the password the resident guest holds is untouched.
  expect(appDb.provision).toHaveBeenCalledTimes(1);
  const stored = await secrets.get("app-db:my-agent");
  expect(JSON.parse(stored ?? "")).toMatchObject({ tier: "workflow", password: META.password });
  expect(stored).not.toBe(afterFirst);
});

test("re-enabling at the SAME tier reconciles nothing", async () => {
  const reconcileTier = vi.fn(async () => ({ changed: true }));
  const appDb = fakeAppDb();
  const withTier = fakeAppDatabases({
    provision: appDb.provision,
    reconcileTier,
    withAppDb: (_meta, fn) => fn(async () => []),
  });
  const { fetch } = await deployWithStorage({ appDb: withTier });

  await tierReq(fetch, "storage");
  await tierReq(fetch, "storage");
  // An unconditional `alter role` would be harmless and a needless write on the
  // hot idempotent path; what makes the guard load-bearing is `rebuildGuest`,
  // which a no-op reconcile must not trigger.
  expect(reconcileTier).not.toHaveBeenCalled();
});

/**
 * A failed reconcile must not fail the request: the database exists and its
 * credentials are stored, so reporting "could not enable" for a working database
 * is the same misreport the session-grant heal beside it avoids.
 */
test("a reconcile failure is reported and the request still succeeds", async () => {
  const appDb = fakeAppDb();
  const withTier = fakeAppDatabases({
    provision: appDb.provision,
    reconcileTier: async () => {
      throw new Error("cluster unreachable");
    },
    withAppDb: (_meta, fn) => fn(async () => []),
  });
  const { fetch } = await deployWithStorage({ appDb: withTier });

  await tierReq(fetch, "storage");
  const again = await tierReq(fetch, "workflow");
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ ok: true, enabled: true });
});
