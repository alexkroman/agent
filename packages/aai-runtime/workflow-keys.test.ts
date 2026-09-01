// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the correlation-key index.
 *
 * The Postgres half is exercised against a recording `Db` rather than a real
 * server: what can go wrong here is the SHAPE of the work — the DDL running more
 * than once under concurrency, the ordering clause losing its ULID tiebreak, an
 * idempotent re-record turning into an error — and all of those are visible in
 * the statements issued. A real-Postgres pass over the same store belongs in the
 * integration tier.
 */

import { describe, expect, test } from "vitest";
import { recordingDb } from "./_test-utils.ts";
import {
  createMemoryKeyStore,
  createPostgresKeyStore,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_FIND_LIMIT,
  resolveFindLimit,
  WORKFLOW_KEYS_TABLE,
} from "./workflow-keys.ts";

describe("resolveFindLimit", () => {
  test("defaults when the caller names no limit", () => {
    expect(resolveFindLimit(undefined)).toBe(DEFAULT_WORKFLOW_FIND_LIMIT);
  });

  test("clamps to the ceiling so one lookup cannot scan a whole history", () => {
    expect(resolveFindLimit(10_000)).toBe(MAX_WORKFLOW_FIND_LIMIT);
  });

  test("floors at one rather than returning an empty page for 0 or a negative", () => {
    expect(resolveFindLimit(0)).toBe(1);
    expect(resolveFindLimit(-5)).toBe(1);
  });

  test("truncates a fractional limit instead of passing it to SQL", () => {
    expect(resolveFindLimit(3.7)).toBe(3);
  });

  test("treats a non-finite limit as unspecified", () => {
    expect(resolveFindLimit(Number.NaN)).toBe(DEFAULT_WORKFLOW_FIND_LIMIT);
    expect(resolveFindLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WORKFLOW_FIND_LIMIT);
  });
});

describe("the memory key store", () => {
  test("returns runs for a key newest first", async () => {
    const keys = createMemoryKeyStore();
    await keys.record("digest", "caller", "first");
    await keys.record("digest", "caller", "second");
    expect(await keys.lookup("digest", "caller", 10)).toEqual(["second", "first"]);
  });

  test("honours the limit", async () => {
    const keys = createMemoryKeyStore();
    for (const id of ["a", "b", "c"]) await keys.record("digest", "caller", id);
    expect(await keys.lookup("digest", "caller", 2)).toEqual(["c", "b"]);
  });

  test("keeps two workflows' identical keys apart", async () => {
    const keys = createMemoryKeyStore();
    await keys.record("digest", "caller", "digest-run");
    await keys.record("transcribe", "caller", "transcribe-run");
    expect(await keys.lookup("digest", "caller", 10)).toEqual(["digest-run"]);
    expect(await keys.lookup("transcribe", "caller", 10)).toEqual(["transcribe-run"]);
  });

  test("resolves empty for an unknown key", async () => {
    expect(await createMemoryKeyStore().lookup("digest", "nobody", 10)).toEqual([]);
  });
});

describe("the Postgres key store", () => {
  test("creates the table and its lookup index on first use", async () => {
    const db = recordingDb();
    await createPostgresKeyStore(db).record("digest", "caller", "wrun_1");
    expect(db.sql[0]).toContain(`create table if not exists ${WORKFLOW_KEYS_TABLE}`);
    expect(db.sql[1]).toContain(`create index if not exists ${WORKFLOW_KEYS_TABLE}_lookup`);
  });

  test("runs the DDL once across CONCURRENT first calls", async () => {
    const db = recordingDb();
    const store = createPostgresKeyStore(db);
    // The memoization is on the promise, not on a boolean set after the await —
    // concurrent `create table if not exists` on one name take conflicting locks,
    // so a second DDL here is a deadlock rather than a wasted statement.
    await Promise.all([
      store.record("digest", "a", "wrun_1"),
      store.record("digest", "b", "wrun_2"),
      store.lookup("digest", "a", 10),
    ]);
    expect(db.sql.filter((s: string) => s.includes("create table"))).toHaveLength(1);
    expect(db.sql.filter((s: string) => s.includes("create index"))).toHaveLength(1);
  });

  test("re-recording one run is a no-op rather than an error", async () => {
    const db = recordingDb();
    await createPostgresKeyStore(db).record("digest", "caller", "wrun_1");
    // A retried `record` after a lost connection must not surface in a tool call.
    expect(db.sql.at(-1)).toContain("on conflict (run_id) do nothing");
  });

  test("orders newest first with the ULID tiebreak", async () => {
    const db = recordingDb();
    await createPostgresKeyStore(db).lookup("digest", "caller", 5);
    // Run ids are ULIDs and sort lexicographically by generation time, so this is
    // what keeps two runs recorded in the same millisecond in the right order.
    expect(db.sql.at(-1)).toContain("order by created_at desc, run_id desc");
  });

  test("passes the workflow, key and limit as parameters, never interpolated", async () => {
    const db = recordingDb();
    const store = createPostgresKeyStore(db);
    await store.lookup("digest", "caller'; drop table users; --", 5);
    const { sql: statement, params } = db.issued.at(-1) ?? { sql: "", params: [] };
    expect(statement).toContain("where workflow = $1 and key = $2");
    expect(params).toEqual(["digest", "caller'; drop table users; --", 5]);
  });

  test("maps rows to run ids", async () => {
    const db = recordingDb([[], [], [{ run_id: "wrun_2" }, { run_id: "wrun_1" }]]);
    expect(await createPostgresKeyStore(db).lookup("digest", "caller", 10)).toEqual([
      "wrun_2",
      "wrun_1",
    ]);
  });
});
