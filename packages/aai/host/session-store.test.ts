// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the durable-resume stores.
 *
 * The Postgres store is exercised against a recording fake `Db` rather than a
 * live database: what these assert is the CONTRACT the runtime depends on
 * (a miss reads as null, a snapshot survives a round trip, an expired row is
 * not served, a malformed row does not become `ctx.state`), all of which is
 * decided by this module rather than by Postgres.
 */

import { describe, expect, test, vi } from "vitest";
import type { Db } from "../sdk/db.ts";
import {
  createDbSessionStore,
  createMemorySessionStore,
  resolveSessionStore,
  type SessionSnapshot,
  serializeSnapshot,
} from "./session-store.ts";

/** A `Db` whose every query is answered by `rows`, recording what it was asked. */
function fakeDb(rows: Record<string, unknown>[] = []): Db & { sql: string[]; params: unknown[][] } {
  const sql: string[] = [];
  const params: unknown[][] = [];
  return {
    sql,
    params,
    query: (<T>(q: string, p?: unknown[]) => {
      sql.push(q);
      params.push(p ?? []);
      // Only the select returns anything; the DDL/upsert/delete resolve empty.
      return Promise.resolve((q.includes("select") ? rows : []) as T[]);
    }) as Db["query"],
  };
}

describe("createMemorySessionStore", () => {
  test("round-trips a snapshot and reports a miss as null", async () => {
    const store = createMemorySessionStore();
    await expect(store.load("absent")).resolves.toBeNull();
    await store.save("s1", { state: { cart: ["apple"] }, providerSessionId: "prov-1" });
    await expect(store.load("s1")).resolves.toEqual({
      state: { cart: ["apple"] },
      providerSessionId: "prov-1",
    });
  });

  test("snapshots by value — a later mutation of the live state does not reach the store", async () => {
    const store = createMemorySessionStore();
    const state: Record<string, unknown> = { cart: ["apple"] };
    await store.save("s1", { state });
    // This is what `ctx.state` does between writes; holding the caller's
    // object would make the assertion below pass for the wrong reason.
    (state.cart as string[]).push("pear");
    const loaded = await store.load("s1");
    expect(loaded?.state).toEqual({ cart: ["apple"] });
  });

  test("delete removes the snapshot", async () => {
    const store = createMemorySessionStore();
    await store.save("s1", { state: {} });
    await store.delete("s1");
    await expect(store.load("s1")).resolves.toBeNull();
  });
});

describe("createDbSessionStore", () => {
  test("creates its table once, however many calls follow", async () => {
    const db = fakeDb();
    const store = createDbSessionStore({ db });
    await Promise.all([store.load("a"), store.load("b")]);
    await store.save("a", { state: {} });
    const ddl = db.sql.filter((q) => q.includes("create table"));
    expect(ddl).toHaveLength(1);
  });

  test("a failed DDL is retried rather than cached as a permanent failure", async () => {
    let attempt = 0;
    const db: Db = {
      query: (<T>(q: string) => {
        if (q.includes("create table") && attempt++ === 0) {
          return Promise.reject(new Error("database is starting up"));
        }
        return Promise.resolve([] as T[]);
      }) as Db["query"],
    };
    const store = createDbSessionStore({ db });
    await expect(store.load("a")).rejects.toThrow("database is starting up");
    await expect(store.load("a")).resolves.toBeNull();
  });

  test("load returns the stored snapshot", async () => {
    const snapshot: SessionSnapshot = { state: { turn: 3 }, providerSessionId: "prov-9" };
    const db = fakeDb([{ snapshot }]);
    const store = createDbSessionStore({ db });
    await expect(store.load("s1")).resolves.toEqual(snapshot);
  });

  test("filters expiry in SQL, so the guest's clock is never compared to the database's", async () => {
    const db = fakeDb();
    const store = createDbSessionStore({ db, ttlMs: 45_000 });
    await store.load("s1");
    const select = db.sql.find((q) => q.includes("select snapshot"));
    expect(select).toContain("updated_at >");
    expect(db.params.at(-1)).toEqual(["s1", "45000"]);
  });

  test("a row whose state is not a plain object is ignored, not installed as ctx.state", async () => {
    for (const bad of [null, "nope", 42, ["a"]]) {
      const db = fakeDb([{ snapshot: { state: bad } }]);
      const store = createDbSessionStore({ db });
      await expect(store.load("s1"), `state: ${JSON.stringify(bad)}`).resolves.toBeNull();
    }
  });

  test("a non-string providerSessionId is dropped rather than forwarded to the service", async () => {
    const db = fakeDb([{ snapshot: { state: {}, providerSessionId: 7 } }]);
    const store = createDbSessionStore({ db });
    await expect(store.load("s1")).resolves.toEqual({ state: {} });
  });

  test("save upserts and sweeps expired rows", async () => {
    const db = fakeDb();
    const store = createDbSessionStore({ db });
    await store.save("s1", { state: { a: 1 } });
    expect(db.sql.some((q) => q.includes("on conflict (session_id)"))).toBe(true);
    expect(db.sql.some((q) => q.startsWith("delete from"))).toBe(true);
  });

  test("a failed sweep does not fail the write it rides on", async () => {
    const db: Db = {
      query: (<T>(q: string) => {
        if (q.startsWith("delete from")) return Promise.reject(new Error("lock timeout"));
        return Promise.resolve([] as T[]);
      }) as Db["query"],
    };
    const store = createDbSessionStore({ db });
    await expect(store.save("s1", { state: {} })).resolves.toBeUndefined();
  });

  test("refuses a table name that is not a bare identifier", () => {
    const db = fakeDb();
    expect(() => createDbSessionStore({ db, table: "x; drop table users" })).toThrow(
      /Invalid session-store table name/,
    );
  });
});

describe("serializeSnapshot", () => {
  test("returns the JSON for a serializable snapshot", () => {
    const result = serializeSnapshot({ state: { a: 1 } });
    expect(result).toEqual({ json: '{"state":{"a":1}}' });
  });

  test("reports a cycle instead of throwing on the write path", () => {
    const state: Record<string, unknown> = {};
    state.self = state;
    const result = serializeSnapshot({ state });
    expect(result).toHaveProperty("error");
  });

  test("reports a value JSON refuses outright", () => {
    const result = serializeSnapshot({ state: { big: 1n } });
    expect(result).toHaveProperty("error");
  });

  test("a throwing toJSON is reported, not propagated", () => {
    const state = {
      hostile: {
        toJSON: vi.fn(() => {
          throw new Error("no");
        }),
      },
    };
    expect(serializeSnapshot({ state })).toHaveProperty("error");
    expect(state.hostile.toJSON).toHaveBeenCalled();
  });
});

describe("resolveSessionStore", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  test("an injected store wins over everything, database or not", () => {
    const explicit = createMemorySessionStore();
    expect(
      resolveSessionStore({ explicit, persistSessions: undefined, db: undefined, logger }),
    ).toBe(explicit);
  });

  test("off by default — an agent that did not ask keeps the pre-store behaviour", () => {
    expect(
      resolveSessionStore({
        explicit: undefined,
        persistSessions: undefined,
        db: fakeDb(),
        logger,
      }),
    ).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("persistSessions with storage builds a database-backed store", async () => {
    const db = fakeDb();
    const store = resolveSessionStore({
      explicit: undefined,
      persistSessions: true,
      db,
      logger,
    });
    expect(store).toBeDefined();
    // It is really the Postgres one, over the handle it was given.
    await store?.save("s1", { state: { a: 1 } });
    expect(db.sql.some((q) => q.includes("create table if not exists"))).toBe(true);
  });

  test("persistSessions WITHOUT storage warns and degrades — never throws", () => {
    // Failing a deploy over a resumability feature would be a far worse trade
    // than the startup line it costs to say so.
    const warn = vi.fn();
    const store = resolveSessionStore({
      explicit: undefined,
      persistSessions: true,
      db: undefined,
      logger: { ...logger, warn },
    });
    expect(store).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("aai storage enable"));
  });
});
