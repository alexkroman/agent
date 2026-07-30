// Copyright 2026 the AAI authors. MIT license.
import { expect, test, vi } from "vitest";
import type { AppDatabases, AppDbMeta } from "./app-database.ts";
import { createMemorySecretStore, type SecretStore } from "./secret-store.ts";
import { createTestOrchestrator, deployAgent } from "./test-utils.ts";

const META: AppDbMeta = {
  schema: "app_0123456789abcdef",
  role: "app_0123456789abcdef",
  password: "f".repeat(32),
};

function fakeAppDb(): AppDatabases & {
  provision: ReturnType<typeof vi.fn>;
  deprovision: ReturnType<typeof vi.fn>;
} {
  return {
    provision: vi.fn(async () => META),
    deprovision: vi.fn(async () => undefined),
    open: () => {
      throw new Error("open not expected in these tests");
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
  expect(appDb.deprovision).toHaveBeenCalledWith("my-agent");
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
  expect(appDb.deprovision).toHaveBeenCalledWith("my-agent");
  // The credential secret goes too (via handleDelete → store.deleteAgent for
  // the real store; the orchestrator's secret store is authoritative here).
  expect(await secrets.get("app-db:my-agent")).toBeNull();
});
