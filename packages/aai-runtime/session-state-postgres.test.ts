// Copyright 2026 the AAI authors. MIT license.
/**
 * The SQL contract of the Postgres backend, against a recording `Db`.
 *
 * `session-state.scenario.test.ts` in `aai-server` drives this same backend
 * against a real Postgres and is where the DDL, the conflict handling and the
 * driver's own behaviour are proven. It needs a database, so it is a SCENARIO
 * test and cannot answer the question these specs ask: which statements does a
 * given call make, and against which table. That is a property of THIS module
 * — a grant elsewhere decides whether the statement is allowed, so a backend
 * that quietly issues one more than it should reads as a permission error in
 * production and as nothing at all here.
 */

import type { Db } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import {
  createPostgresStateBackend,
  SESSION_EVENT_TABLE,
  SESSION_STATE_TABLE,
} from "./session-state-postgres.ts";

/** A `Db` that records what it was asked and answers with what it was given. */
function recordingDb(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db: Db = {
    query: <T>(sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return Promise.resolve(rows as T[]);
    },
  };
  return { db, calls };
}

const backendOn = (db: Db) => createPostgresStateBackend({ db });

describe("discard", () => {
  test("deletes SLOTS and nothing else", async () => {
    const { db, calls } = recordingDb();

    await backendOn(db).discard("s1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain(`delete from ${SESSION_STATE_TABLE}`);
    expect(calls[0]?.params).toEqual(["s1"]);
  });

  // The event table is append-only to the app's own role by grant
  // (`grantSessionTables` in aai-server), so a delete against it would not
  // merely be wrong here — it would fail at the database and take the discard
  // with it. Asserted separately from the count above because THIS is the
  // regression: a `delete from aai_session_events` used to run beside it.
  test("issues no statement against the event table", async () => {
    const { db, calls } = recordingDb();

    await backendOn(db).discard("s1");

    expect(calls.some((c) => c.sql.includes(SESSION_EVENT_TABLE))).toBe(false);
  });
});

describe("slots", () => {
  test("load reads one session's rows and keys them by slot", async () => {
    const { db, calls } = recordingDb([
      { slot: "cart", value: '{"n":1}' },
      { slot: "user", value: '"alex"' },
    ]);

    const loaded = await backendOn(db).load("s1");

    expect(loaded).toEqual(
      new Map([
        ["cart", '{"n":1}'],
        ["user", '"alex"'],
      ]),
    );
    expect(calls[0]?.params).toEqual(["s1"]);
  });

  test("commit sends however many slots changed as ONE statement", async () => {
    const { db, calls } = recordingDb();

    await backendOn(db).commit(
      "s1",
      new Map([
        ["cart", '{"n":1}'],
        ["user", '"alex"'],
      ]),
    );

    expect(calls).toHaveLength(1);
    // Parallel arrays, not a generated values list — see COMMIT_SQL.
    expect(calls[0]?.params).toEqual(["s1", ["cart", "user"], ['{"n":1}', '"alex"']]);
  });
});

describe("events", () => {
  test("append sends the index the caller assigned, never one the table invents", async () => {
    const { db, calls } = recordingDb();

    await backendOn(db).appendEvents("s1", [
      { index: 7, json: '{"t":"a"}' },
      { index: 8, json: '{"t":"b"}' },
    ]);

    expect(calls[0]?.params).toEqual(["s1", [7, 8], ['{"t":"a"}', '{"t":"b"}']]);
    expect(calls[0]?.sql).toContain("do nothing");
  });

  test("read hands back numeric indexes, whatever the driver called them", async () => {
    // bigint comes back as a string from some drivers; a caller comparing it to
    // a number would silently never match.
    const { db } = recordingDb([{ event_index: "7", event: '{"t":"a"}' }]);

    expect(await backendOn(db).readEvents("s1", 7, 10)).toEqual([{ index: 7, json: '{"t":"a"}' }]);
  });

  test("count is the next free index, and 0 for a session with no events", async () => {
    const withRows = recordingDb([{ count: 12 }]);
    expect(await backendOn(withRows.db).countEvents("s1")).toBe(12);
    expect(withRows.calls[0]?.sql).toContain("max(event_index) + 1");

    const empty = recordingDb([]);
    expect(await backendOn(empty.db).countEvents("s1")).toBe(0);
  });
});
