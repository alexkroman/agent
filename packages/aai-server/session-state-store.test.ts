// Copyright 2026 the AAI authors. MIT license.

import { SESSION_RESUME_GRACE_MS } from "@alexkroman1/aai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SqlExec } from "./secret-store.ts";
import { createMemorySessionStateStore, createPgSessionStateStore } from "./session-state-store.ts";

describe("createMemorySessionStateStore", () => {
  test("round-trips saved state and notes", async () => {
    const store = createMemorySessionStateStore();
    await store.save("my-agent", "s1", { state: { count: 2 }, notes: { user_id: "u-9" } });
    await expect(store.load("my-agent", "s1")).resolves.toEqual({
      state: { count: 2 },
      notes: { user_id: "u-9" },
    });
  });

  test("returns null for an unknown session", async () => {
    const store = createMemorySessionStateStore();
    await expect(store.load("my-agent", "nope")).resolves.toBeNull();
  });

  test("never serves one agent's state to another (slug scoping)", async () => {
    const store = createMemorySessionStateStore();
    await store.save("agent-a", "s1", { state: { secret: "a" } });
    await expect(store.load("agent-b", "s1")).resolves.toBeNull();
  });

  test("state expires with the resume grace window", async () => {
    vi.useFakeTimers();
    try {
      const store = createMemorySessionStateStore();
      await store.save("my-agent", "s1", { state: { count: 1 } });
      vi.advanceTimersByTime(SESSION_RESUME_GRACE_MS + 1);
      await expect(store.load("my-agent", "s1")).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("callers never share mutable state with the store", async () => {
    const store = createMemorySessionStateStore();
    const data = { state: { items: [1] } };
    await store.save("my-agent", "s1", data);
    data.state.items.push(2);
    const loaded = await store.load("my-agent", "s1");
    expect(loaded?.state).toEqual({ items: [1] });
  });
});

// ── Postgres-backed store ───────────────────────────────────────────────────

/**
 * Fake `SqlExec` reproducing the store's three statements (upsert, filtered
 * select, expired sweep) over an in-memory table with an injectable clock.
 */
function fakeSessionStateDb(clock: { now: number }) {
  const rows = new Map<string, { slug: string; data: string; expiresAt: number }>();
  const statements: string[] = [];

  const sweep = () => {
    for (const [k, row] of rows) {
      if (row.expiresAt <= clock.now) rows.delete(k);
    }
    return [];
  };
  const upsert = (params: unknown[]) => {
    const [sessionId, slug, data, ttlMs] = params as [string, string, string, number];
    rows.set(sessionId, { slug, data, expiresAt: clock.now + ttlMs });
    return [];
  };
  const select = (params: unknown[]) => {
    const [sessionId, slug] = params as [string, string];
    const row = rows.get(sessionId);
    if (!row || row.slug !== slug || row.expiresAt <= clock.now) return [];
    return [{ data: JSON.parse(row.data) as unknown }];
  };

  const exec: SqlExec = (query, params = []) => {
    statements.push(query);
    if (query.startsWith("create")) return Promise.resolve([]);
    if (query.startsWith("delete")) return Promise.resolve(sweep());
    if (query.startsWith("insert")) return Promise.resolve(upsert(params));
    return Promise.resolve(select(params));
  };
  return { exec, rows, statements };
}

describe("createPgSessionStateStore", () => {
  const clock = { now: 1_000_000 };

  beforeEach(() => {
    clock.now = 1_000_000;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("round-trips saved state and notes", async () => {
    const db = fakeSessionStateDb(clock);
    const store = createPgSessionStateStore(db.exec);
    await store.save("my-agent", "s1", { state: { count: 2 }, notes: { user_id: "u-9" } });
    await expect(store.load("my-agent", "s1")).resolves.toEqual({
      state: { count: 2 },
      notes: { user_id: "u-9" },
    });
  });

  test("save overwrites the previous snapshot for the session", async () => {
    const db = fakeSessionStateDb(clock);
    const store = createPgSessionStateStore(db.exec);
    await store.save("my-agent", "s1", { state: { count: 1 } });
    await store.save("my-agent", "s1", { state: { count: 2 } });
    await expect(store.load("my-agent", "s1")).resolves.toEqual({ state: { count: 2 } });
  });

  test("never serves one agent's state to another (slug scoping)", async () => {
    const db = fakeSessionStateDb(clock);
    const store = createPgSessionStateStore(db.exec);
    await store.save("agent-a", "s1", { state: { secret: "a" } });
    await expect(store.load("agent-b", "s1")).resolves.toBeNull();
  });

  test("expired rows read as missing", async () => {
    const db = fakeSessionStateDb(clock);
    const store = createPgSessionStateStore(db.exec);
    await store.save("my-agent", "s1", { state: { count: 1 } });
    clock.now += SESSION_RESUME_GRACE_MS + 1;
    await expect(store.load("my-agent", "s1")).resolves.toBeNull();
  });

  test("a corrupt row degrades to a stateless resume, not a failure", async () => {
    const db = fakeSessionStateDb(clock);
    const store = createPgSessionStateStore(db.exec);
    await store.save("my-agent", "s1", { state: { count: 1 } });
    const row = db.rows.get("s1");
    if (row) row.data = JSON.stringify({ notes: { k: 42 } }); // wrong value type
    await expect(store.load("my-agent", "s1")).resolves.toBeNull();
  });

  test("saving sweeps expired rows opportunistically", async () => {
    const db = fakeSessionStateDb(clock);
    const store = createPgSessionStateStore(db.exec);
    await store.save("my-agent", "old", { state: { count: 1 } });
    clock.now += SESSION_RESUME_GRACE_MS + 1;
    await store.save("my-agent", "fresh", { state: { count: 2 } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.rows.has("old")).toBe(false);
    expect(db.rows.has("fresh")).toBe(true);
  });

  test("ensures schema and table once", async () => {
    const db = fakeSessionStateDb(clock);
    const store = createPgSessionStateStore(db.exec);
    await store.save("my-agent", "s1", { state: {} });
    await store.load("my-agent", "s1");
    expect(db.statements.filter((s) => s.startsWith("create")).length).toBe(3); // schema + table + index
  });
});
