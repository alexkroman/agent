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

import type { Db } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import {
  applySessionStateDdl,
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
  test("deletes BOTH tables in ONE statement", async () => {
    // A recorder's own question: not WHETHER both tables are reclaimed — that is
    // the contract, asserted on every arm by `session-state-conformance.ts` —
    // but whether it takes one round trip. A single statement is what makes the
    // pair atomic with respect to a concurrent `appendEvents`: two awaited
    // deletes on an unwrapped connection are two implicit transactions, so an
    // append landing between them leaves orphan event rows for a session that no
    // longer has slots. Only a statement COUNT can see that, and only here.
    const { db, calls } = recordingDb();

    await backendOn(db).discard("s1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain(`delete from ${SESSION_STATE_TABLE}`);
    expect(calls[0]?.sql).toContain(`delete from ${SESSION_EVENT_TABLE}`);
    expect(calls[0]?.params).toEqual(["s1"]);
  });

  // **This case used to assert the OPPOSITE** — "issues no statement against the
  // event table", on the rule that a log a tool can delete is not a log. That
  // rested on an append-only GRANT (`grantSessionTables` in aai-server) which
  // went with per-app databases, leaving the assertion as the only thing keeping
  // the two backends apart — and what they were apart ON was the meaning of
  // "discarded". Decided the other way; see `session-state-conformance.ts`. What
  // is kept from it is the SCOPING, which is the risk a widened delete carries:
  // both arms have to name the session.
  test("scopes both deletes to the one session", async () => {
    const { db, calls } = recordingDb();

    await backendOn(db).discard("s1");

    const sql = calls[0]?.sql ?? "";
    expect(sql.match(/where session_id = \$1/g)).toHaveLength(2);
    // One parameter, used twice — so the two arms cannot come to name different
    // sessions.
    expect(calls[0]?.params).toEqual(["s1"]);
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

describe("applySessionStateDdl", () => {
  /** A logger that records only what this function is specified to emit. */
  function capturingLogger() {
    const warnings: string[] = [];
    const noop = () => undefined;
    return {
      warnings,
      logger: { debug: noop, info: noop, warn: (m: string) => void warnings.push(m), error: noop },
    };
  }

  test("issues the DDL for BOTH tables", async () => {
    // The regression this closes: `aai dev` reported `sessionState: postgres,
    // durable: true` against a database where neither table existed, and every
    // session then died at start on the events one.
    const { db, calls } = recordingDb();
    const { logger, warnings } = capturingLogger();

    expect(await applySessionStateDdl({ db, logger })).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain(SESSION_STATE_TABLE);
    expect(calls[1]?.sql).toContain(SESSION_EVENT_TABLE);
    expect(warnings).toEqual([]);
  });

  test("the statements are `if not exists`, so a second boot is a no-op", async () => {
    const { db, calls } = recordingDb();
    const { logger } = capturingLogger();
    await applySessionStateDdl({ db, logger });
    for (const call of calls) expect(call.sql).toContain("create table if not exists");
  });

  test("a failure WARNS and returns false rather than throwing", async () => {
    // Never fatal: a self-hosted role that may not CREATE because a real
    // migration already made these tables has to keep booting, and the
    // backend's own error is the better diagnostic if they truly are absent.
    const db: Db = {
      query: () => Promise.reject(new Error("permission denied for schema public")),
    };
    const { logger, warnings } = capturingLogger();

    expect(await applySessionStateDdl({ db, logger })).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("permission denied for schema public");
    // Names both tables, so the warning alone says what to create.
    expect(warnings[0]).toContain(SESSION_STATE_TABLE);
    expect(warnings[0]).toContain(SESSION_EVENT_TABLE);
  });

  test("stops at the first failing statement", async () => {
    let seen = 0;
    const db: Db = {
      query: () => {
        seen += 1;
        return Promise.reject(new Error("nope"));
      },
    };
    const { logger } = capturingLogger();
    await applySessionStateDdl({ db, logger });
    expect(seen).toBe(1);
  });
});
