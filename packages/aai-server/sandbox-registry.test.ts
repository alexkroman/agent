// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  createMemorySandboxRegistry,
  createPgSandboxRegistry,
  REGISTRY_HEARTBEAT_MS,
  REGISTRY_LEASE_MS,
} from "./sandbox-registry.ts";
import type { SqlExec } from "./secret-store.ts";

test("the heartbeat renews well inside the lease", () => {
  // Two missed beats must still leave the lease live, or a single slow
  // event-loop tick would flap every registration.
  expect(REGISTRY_HEARTBEAT_MS * 2).toBeLessThan(REGISTRY_LEASE_MS);
});

describe("createPgSandboxRegistry", () => {
  function captureSql() {
    const calls: { query: string; params?: unknown[] }[] = [];
    const sql: SqlExec = (query, params) => {
      calls.push({ query, ...(params && { params }) });
      return Promise.resolve([]);
    };
    return { sql, calls };
  }

  test("register upserts with this replica's id and the lease", async () => {
    const { sql, calls } = captureSql();
    const registry = createPgSandboxRegistry(sql, { replicaId: "r1", leaseMs: 5000 });
    await registry.register("slug", "wss://tunnel/session", 3);
    const call = calls.at(-1);
    expect(call?.query).toContain("on conflict (slug, session_url) do update");
    expect(call?.params).toEqual(["slug", "wss://tunnel/session", "r1", 3, 5000]);
  });

  test("listPeers excludes this replica and expired leases, least-loaded first", async () => {
    const { sql, calls } = captureSql();
    const registry = createPgSandboxRegistry(sql, { replicaId: "r1" });
    await registry.listPeers("slug");
    const call = calls.at(-1);
    expect(call?.query).toContain("replica_id <> $2");
    expect(call?.query).toContain("expires_at > now()");
    expect(call?.query).toContain("order by sessions asc");
    expect(call?.params).toEqual(["slug", "r1"]);
  });

  test("unregister deletes the registration row", async () => {
    const { sql, calls } = captureSql();
    const registry = createPgSandboxRegistry(sql, { replicaId: "r1" });
    await registry.unregister("slug", "wss://tunnel/session");
    expect(calls.at(-1)?.query).toContain("delete from aai_platform.sandbox_registry");
    expect(calls.at(-1)?.params).toEqual(["slug", "wss://tunnel/session"]);
  });
});

describe("createMemorySandboxRegistry", () => {
  test("listPeers never returns this replica's own registrations", async () => {
    const registry = createMemorySandboxRegistry("me");
    await registry.register("slug", "wss://own/session", 0);
    await expect(registry.listPeers("slug")).resolves.toEqual([]);
  });

  test("peer registrations come back least-loaded first, per slug", async () => {
    const registry = createMemorySandboxRegistry("me");
    registry.registerPeer("slug", "wss://busy/session", 5);
    registry.registerPeer("slug", "wss://idle/session", 1);
    registry.registerPeer("other", "wss://other/session", 0);
    await expect(registry.listPeers("slug")).resolves.toEqual([
      { sessionUrl: "wss://idle/session", sessions: 1 },
      { sessionUrl: "wss://busy/session", sessions: 5 },
    ]);
  });

  test("unregister removes a registration", async () => {
    const registry = createMemorySandboxRegistry("me");
    registry.registerPeer("slug", "wss://peer/session", 0);
    await registry.unregister("slug", "wss://peer/session");
    await expect(registry.listPeers("slug")).resolves.toEqual([]);
  });
});
