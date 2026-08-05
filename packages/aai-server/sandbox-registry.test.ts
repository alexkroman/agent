// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  createMemorySandboxRegistry,
  createPgSandboxRegistry,
  type RegisteredSandbox,
} from "./sandbox-registry.ts";

const entry = (n: number): RegisteredSandbox => ({
  sessionUrl: `wss://guest-${n}.example/websocket`,
  guestOrigin: `wss://guest-${n}.example`,
});

describe("memory sandbox registry", () => {
  test("never reports this replica's own sandbox as a peer", async () => {
    // The whole point of the replica id: a registry that returned your own
    // row would route every cold broker at the sandbox you were about to
    // rebuild anyway, and in a single process there is no peer at all.
    const registry = createMemorySandboxRegistry("replica-a");
    await registry.register("slug", entry(1));
    expect(await registry.findPeer("slug")).toBeNull();
  });

  test("reports another replica's live sandbox", async () => {
    const registry = createMemorySandboxRegistry("replica-a");
    registry.registerPeer("slug", entry(2));
    expect(await registry.findPeer("slug")).toEqual(entry(2));
  });

  test("scopes peers by slug", async () => {
    const registry = createMemorySandboxRegistry("replica-a");
    registry.registerPeer("other-slug", entry(2));
    expect(await registry.findPeer("slug")).toBeNull();
  });

  test("unregister drops the row", async () => {
    const registry = createMemorySandboxRegistry("replica-a");
    registry.registerPeer("slug", entry(2));
    await registry.unregister("slug", entry(2).sessionUrl);
    expect(await registry.findPeer("slug")).toBeNull();
  });
});

describe("postgres sandbox registry", () => {
  /** Records the SQL a call issues, answering selects from a fixed row set. */
  function fakeSql(rows: Record<string, unknown>[] = []) {
    const calls: { query: string; params: unknown[] }[] = [];
    const sql = (query: string, params: unknown[] = []) => {
      calls.push({ query, params });
      return Promise.resolve(query.trimStart().startsWith("select") ? rows : []);
    };
    return { sql, calls };
  }

  test("register upserts with the replica id and a lease", async () => {
    const { sql, calls } = fakeSql();
    const registry = createPgSandboxRegistry(sql, { replicaId: "replica-a", leaseMs: 5000 });
    await registry.register("slug", entry(1));
    const insert = calls.find((c) => c.query.includes("insert into"));
    expect(insert?.params).toEqual([
      "slug",
      entry(1).sessionUrl,
      entry(1).guestOrigin,
      "replica-a",
      5000,
    ]);
    // Upsert, not insert-or-throw: a heartbeat re-registers the same row.
    expect(insert?.query).toContain("on conflict (slug, session_url) do update");
  });

  test("findPeer filters out this replica and expired leases", async () => {
    const { sql, calls } = fakeSql([
      { session_url: entry(2).sessionUrl, guest_origin: entry(2).guestOrigin },
    ]);
    const registry = createPgSandboxRegistry(sql, { replicaId: "replica-a" });
    expect(await registry.findPeer("slug")).toEqual(entry(2));
    const select = calls.find((c) => c.query.trimStart().startsWith("select"));
    expect(select?.params).toEqual(["slug", "replica-a"]);
    expect(select?.query).toContain("replica_id <> $2");
    expect(select?.query).toContain("expires_at > now()");
  });

  test("findPeer resolves null with no live rows", async () => {
    const { sql } = fakeSql([]);
    const registry = createPgSandboxRegistry(sql, { replicaId: "replica-a" });
    expect(await registry.findPeer("slug")).toBeNull();
  });
});
