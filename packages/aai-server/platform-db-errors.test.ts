// Copyright 2026 the AAI authors. MIT license.
/**
 * The reachability/fault split, and the pool wrapper that applies it.
 *
 * Both halves matter equally and for opposite reasons: a connection failure
 * misclassified as a fault costs the caller its retry (production answered 500
 * on `/studio/account` for 20+ minutes), and a real SQL fault misclassified as
 * unavailability tells the caller to retry a query that can never succeed.
 */

import type { CloseableDb, ReservedDb } from "@alexkroman1/aai-runtime";
import { describe, expect, test, vi } from "vitest";
import {
  isPlatformDbUnreachable,
  PlatformDbUnavailableError,
  platformDb,
  withPlatformDb,
} from "./platform-db-errors.ts";

/** An error the way a driver hands one over: a code, and nothing else useful. */
function coded(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** A pool whose every operation rejects with `err`. */
function failingDb(err: unknown): CloseableDb {
  return {
    query: () => Promise.reject(err),
    reserve: () => Promise.reject(err),
    listen: async () => () => undefined,
    close: () => Promise.resolve(),
  };
}

describe("isPlatformDbUnreachable", () => {
  test("recognizes the DNS, connect and socket failures at each layer", () => {
    // libuv (the production outage), postgres.js's own codes, and Postgres's
    // "no connection for you" SQLSTATEs.
    for (const code of [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "CONNECT_TIMEOUT",
      "CONNECTION_CLOSED",
      // The client-side stall bound — the only signal a SILENT partition
      // produces (createPostgresDb's queryTimeoutMs), so it must shed as a 503.
      "QUERY_TIMEOUT",
      // The other client-side bound, one step earlier: no connection was
      // available to RESERVE within `PLATFORM_DB_RESERVE_TIMEOUT_MS`. Same
      // condition as `53300` below, reached before the driver opens a
      // connection rather than after Postgres refuses one — and unbounded it
      // had no code at all, so the caller's own timeout fired instead and the
      // 500 it produced named the wrong layer.
      "POOL_EXHAUSTED",
      "53300",
      "57P03",
    ]) {
      expect(isPlatformDbUnreachable(coded(code))).toBe(true);
    }
  });

  test("a statement that is WRONG is not unreachability", () => {
    // The half that keeps the 503 honest. `42P01` undefined_table, `23505`
    // unique_violation, `42703` undefined_column: all server faults or caller
    // bugs, none of them fixed by retrying.
    for (const code of ["42P01", "23505", "42703"]) {
      expect(isPlatformDbUnreachable(coded(code))).toBe(false);
    }
    expect(isPlatformDbUnreachable(new Error("boom"))).toBe(false);
    expect(isPlatformDbUnreachable("not an error at all")).toBe(false);
  });

  test("walks the cause chain, because postgres.js wraps the socket error", () => {
    const wrapped = new Error("write CONNECTION_CLOSED", { cause: coded("ENOTFOUND") });
    expect(isPlatformDbUnreachable(wrapped)).toBe(true);
  });

  test("a cycle in the cause chain terminates", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(isPlatformDbUnreachable(a)).toBe(false);
  });
});

describe("withPlatformDb", () => {
  test("types a reachability failure and keeps the driver's message and cause", async () => {
    const cause = coded("ENOTFOUND", "getaddrinfo ENOTFOUND db.ref.supabase.co");
    const err = await withPlatformDb(() => Promise.reject(cause)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformDbUnavailableError);
    expect((err as Error).message).toBe("getaddrinfo ENOTFOUND db.ref.supabase.co");
    expect((err as Error).cause).toBe(cause);
  });

  test("passes a SQL fault through untouched, so it stays a 500", async () => {
    const cause = coded("42P01", 'relation "agents" does not exist');
    const err = await withPlatformDb(() => Promise.reject(cause)).catch((e: unknown) => e);
    expect(err).toBe(cause);
  });

  test("does not nest — a reserved query is wrapped twice on one path", async () => {
    const already = new PlatformDbUnavailableError("already typed");
    const err = await withPlatformDb(() => withPlatformDb(() => Promise.reject(already))).catch(
      (e: unknown) => e,
    );
    expect(err).toBe(already);
    expect((err as Error).cause).toBeUndefined();
  });

  test("resolves untouched on success", async () => {
    await expect(withPlatformDb(() => Promise.resolve(7))).resolves.toBe(7);
  });
});

describe("platformDb", () => {
  test("types a pooled query's connection failure", async () => {
    const db = platformDb(failingDb(coded("ENOTFOUND")));
    await expect(db.query("select 1")).rejects.toBeInstanceOf(PlatformDbUnavailableError);
  });

  test("types a failed RESERVE — the wake sweep and the slug lock start there", async () => {
    const db = platformDb(failingDb(coded("CONNECT_TIMEOUT")));
    await expect(db.reserve()).rejects.toBeInstanceOf(PlatformDbUnavailableError);
  });

  test("types a query on a reserved connection, and releases through", async () => {
    const release = vi.fn();
    const reserved: ReservedDb = {
      query: () => Promise.reject(coded("CONNECTION_CLOSED")),
      release,
    };
    const db = platformDb({
      query: () => Promise.resolve([]),
      reserve: () => Promise.resolve(reserved),
      listen: async () => () => undefined,
      close: () => Promise.resolve(),
    });
    const held = await db.reserve();
    await expect(held.query("select 1")).rejects.toBeInstanceOf(PlatformDbUnavailableError);
    held.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("passes rows and close straight through", async () => {
    const close = vi.fn(() => Promise.resolve());
    const db = platformDb({
      query: <T>() => Promise.resolve([{ n: 1 }] as T[]),
      reserve: () => Promise.reject(new Error("unused")),
      listen: async () => () => undefined,
      close,
    });
    await expect(db.query("select 1")).resolves.toEqual([{ n: 1 }]);
    await db.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("a close that throws during shutdown is NOT dressed up as a 503", async () => {
    // Nothing a request-time handler should ever see: the process is going away,
    // and a typed error here would be logged as though a caller were affected.
    const boom = coded("ECONNRESET");
    const db = platformDb({
      query: () => Promise.resolve([]),
      reserve: () => Promise.reject(new Error("unused")),
      listen: async () => () => undefined,
      close: () => Promise.reject(boom),
    });
    await expect(db.close()).rejects.toBe(boom);
  });
});
