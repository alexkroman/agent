// Copyright 2026 the AAI authors. MIT license.
import type { Db } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { SCHEMA_LOCK_SQL, withSchemaLock } from "./_schema-lock.ts";

/** A Db that records every statement, failing the ones `fails` names. */
function recordingDb(fails: (sql: string) => boolean = () => false) {
  const statements: string[] = [];
  const db: Pick<Db, "query"> = {
    async query<T>(sql: string): Promise<T[]> {
      statements.push(sql);
      if (fails(sql)) throw new Error(`failed: ${sql}`);
      return [];
    },
  };
  return { db, statements };
}

describe("withSchemaLock", () => {
  test("takes the advisory lock inside a transaction, then commits a successful batch", async () => {
    const { db, statements } = recordingDb();
    const ok = await withSchemaLock(db, async () => {
      await db.query("create table if not exists t ()");
      return true;
    });
    expect(ok).toBe(true);
    expect(statements).toEqual([
      "begin",
      SCHEMA_LOCK_SQL,
      "create table if not exists t ()",
      "commit",
    ]);
  });

  test("rolls back when the batch reports failure, so nothing partial sticks", async () => {
    const { db, statements } = recordingDb();
    expect(await withSchemaLock(db, async () => false)).toBe(false);
    expect(statements).toEqual(["begin", SCHEMA_LOCK_SQL, "rollback"]);
  });

  test("rolls back and rethrows when the lock or a statement throws", async () => {
    const { db, statements } = recordingDb((sql) => sql === SCHEMA_LOCK_SQL);
    await expect(withSchemaLock(db, async () => true)).rejects.toThrow(/failed/);
    expect(statements).toEqual(["begin", SCHEMA_LOCK_SQL, "rollback"]);
  });
});
