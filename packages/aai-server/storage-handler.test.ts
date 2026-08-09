// Copyright 2026 the AAI authors. MIT license.
import { expect, test, vi } from "vitest";
import type { AppDatabases, AppDbMeta } from "./app-database.ts";
import { createMemorySecretStore, type SecretStore } from "./secret-store.ts";
import { createTestOrchestrator, deployAgent } from "./test-utils.ts";

// Carries a `url`, because that locator is the point of the two deprovision
// assertions below: it names the cluster this app was placed on, and a
// deprovision that recomputes placement instead of reading it drops on the
// wrong cluster after any change to APP_DB_URLS.
const META: AppDbMeta = {
  role: "app_0123456789abcdef",
  password: "f".repeat(32),
  url: "postgres://postgres:pw@cluster-b.example:5432/postgres",
};

function fakeAppDb(): AppDatabases & {
  provision: ReturnType<typeof vi.fn>;
  deprovision: ReturnType<typeof vi.fn>;
} {
  return {
    provision: vi.fn(async () => META),
    deprovision: vi.fn(async () => undefined),
    connectionUrl: () => {
      throw new Error("connectionUrl not expected in these tests");
    },
  };
}

async function deployWithStorage(opts: { appDb?: AppDatabases; secrets?: SecretStore } = {}) {
  const secrets = opts.secrets ?? createMemorySecretStore();
  const orch = await createTestOrchestrator({ secrets, ...(opts.appDb && { appDb: opts.appDb }) });
  await deployAgent(orch.fetch, "my-agent", "key1");
  return { ...orch, secrets };
}

function storageReq(slug: string, key: string, method: string): [string, RequestInit] {
  return [`/${slug}/storage`, { method, headers: { Authorization: `Bearer ${key}` } }];
}

test("storage status rejects without auth", async () => {
  const { fetch } = await deployWithStorage();
  expect((await fetch("/my-agent/storage")).status).toBe(401);
});

test("storage status is disabled by default", async () => {
  const { fetch } = await deployWithStorage();
  const res = await fetch(...storageReq("my-agent", "key1", "GET"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ enabled: false });
});

test("storage enable returns 503 when SUPABASE_DB_URL is unconfigured", async () => {
  const { fetch } = await deployWithStorage(); // no appDb binding
  const res = await fetch(...storageReq("my-agent", "key1", "POST"));
  expect(res.status).toBe(503);
  expect(await res.text()).toContain("SUPABASE_DB_URL");
});

test("storage enable provisions, stores credentials, and reports enabled", async () => {
  const appDb = fakeAppDb();
  const { fetch, secrets } = await deployWithStorage({ appDb });

  const res = await fetch(...storageReq("my-agent", "key1", "POST"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, enabled: true });
  expect(appDb.provision).toHaveBeenCalledWith("my-agent");
  expect(JSON.parse((await secrets.get("app-db:my-agent")) ?? "")).toEqual(META);

  const status = await fetch(...storageReq("my-agent", "key1", "GET"));
  expect(await status.json()).toEqual({ enabled: true });
});

test("storage disable deprovisions, deletes credentials, and reports disabled", async () => {
  const appDb = fakeAppDb();
  const { fetch, secrets } = await deployWithStorage({ appDb });
  await fetch(...storageReq("my-agent", "key1", "POST"));

  const res = await fetch(...storageReq("my-agent", "key1", "DELETE"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, enabled: false });
  // The stored locator reaches deprovision — read BEFORE the secret holding
  // it is deleted on the next line.
  expect(appDb.deprovision).toHaveBeenCalledWith("my-agent", META);
  expect(await secrets.get("app-db:my-agent")).toBeNull();

  const status = await fetch(...storageReq("my-agent", "key1", "GET"));
  expect(await status.json()).toEqual({ enabled: false });
});

test("storage routes reject a non-owner key", async () => {
  const appDb = fakeAppDb();
  const { fetch } = await deployWithStorage({ appDb });
  for (const method of ["GET", "POST", "DELETE"]) {
    const res = await fetch(...storageReq("my-agent", "intruder-key", method));
    expect(res.status).toBe(403);
  }
  expect(appDb.provision).not.toHaveBeenCalled();
});

test("agent delete deprovisions the app database and clears its credentials", async () => {
  const appDb = fakeAppDb();
  const { fetch, secrets } = await deployWithStorage({ appDb });
  await fetch(...storageReq("my-agent", "key1", "POST"));

  const res = await fetch("/my-agent", {
    method: "DELETE",
    headers: { Authorization: "Bearer key1" },
  });
  expect(res.status).toBe(200);
  // Same locator rule as disable, and the ordering is tighter here: the delete
  // path's own `store.deleteAgent` sweeps `app-db:<slug>`, so the read has to
  // happen ahead of it or there is no locator left to read.
  expect(appDb.deprovision).toHaveBeenCalledWith("my-agent", META);
  // The credential secret goes too (via handleDelete → store.deleteAgent for
  // the real store; the orchestrator's secret store is authoritative here).
  expect(await secrets.get("app-db:my-agent")).toBeNull();
});
