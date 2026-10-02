// Copyright 2025 the AAI authors. MIT license.

/** SQL fakes: an `AdminDb` over a responder, and dispatching/recording `SqlExec`s. */

import { vi } from "vitest";
import type { AdminDb } from "./platform/lock.ts";
import type { SqlExec } from "./sql-exec.ts";

/**
 * An {@link AdminDb} whose reserved connection answers `respond` — the ONE
 * narrowing to the row-generic `ReservedDb.query`. `release` is a spy, so a
 * caller can assert the reservation was given back. The responder sees the
 * PARAMS as well as the SQL: two tenants' reads of one table differ only there.
 */
export function fakeAdminDbOver(
  respond: (
    sql: string,
    params?: unknown[],
  ) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>,
): AdminDb & { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn();
  const query = async <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => (await respond(sql, params)) as T[];
  return {
    release,
    reserve: () => Promise.resolve({ release, query }),
    // No-op: a spec that cares about NOTIFY invokes the callback it captured.
    listen: () => Promise.resolve(() => undefined),
  };
}

/** One statement's behaviour in a {@link createDispatchingSql} fake. */
export type SqlHandler = (params: unknown[]) => Record<string, unknown>[];

/** A statement issued against a fake `SqlExec`, in the order it was issued. */
export type SqlCall = { query: string; params: unknown[] };

/**
 * A fake `SqlExec` that dispatches each statement to the FIRST handler whose
 * prefix matches, logging every call for shape assertions.
 *
 * Matching is on the whitespace-collapsed, lower-cased statement, so handler
 * prefixes read like the SQL they stand for. Order matters where one prefix
 * extends another — the workspace store's metadata patch and its versioned
 * update both begin `update <table> set doc =`, so the longer prefix has to
 * be listed first. An unmatched statement REJECTS rather than returning `[]`:
 * a store that grows a statement its fake does not model must fail loudly,
 * not read as an empty result set.
 */
export function createDispatchingSql(handlers: readonly [string, SqlHandler][]): {
  sql: SqlExec;
  log: SqlCall[];
} {
  const log: SqlCall[] = [];
  const sql: SqlExec = (query, params = []) => {
    log.push({ query, params });
    const q = query.replace(/\s+/g, " ").trim().toLowerCase();
    const handler = handlers.find(([prefix]) => q.startsWith(prefix))?.[1];
    if (!handler) return Promise.reject(new Error(`Unexpected query: ${query}`));
    try {
      return Promise.resolve(handler(params));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  return { sql, log };
}

/**
 * A DDL handler that refuses its first `failures` calls, then succeeds — for
 * the stores' "a failed `create table` must not wedge the store" specs.
 */
export function refusingDdl(failures = 0): SqlHandler {
  let remaining = failures;
  return () => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error("ddl refused");
    }
    return [];
  };
}

/**
 * A fake `SqlExec` answering from one `respond` function, as a `vi.fn` — for
 * stores whose specs assert on the statements issued (`mock.calls`, each a
 * `[query, params]` pair) rather than on state accumulated across them.
 */
export function createRecordingSql(
  respond: (query: string, params: unknown[]) => Record<string, unknown>[] = () => [],
) {
  return vi.fn<SqlExec>(async (query, params = []) => respond(query, params));
}

/**
 * Code-unit order, the repo's standing rule for anything an assertion sorts —
 * `localeCompare` with no explicit locale answers to the runtime's ICU default,
 * so the same rows would sort differently on another machine.
 */
export const byCodeUnit = (a: string, b: string): number => Number(a > b) - Number(a < b);
