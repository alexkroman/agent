// Copyright 2026 the AAI authors. MIT license.
// Which key store an embedder gets: its database, or memory.

import { expect, test } from "vitest";
import { recordingDb } from "../_db-test-utils.ts";
import { resolveKeyStore } from "./keys-select.ts";

test("no Db is the memory store: a record is found again with no database at all", async () => {
  const store = resolveKeyStore(undefined);
  await store.record("intake", "caller-7", "wrun_1");
  await expect(store.lookup("intake", "caller-7", 10)).resolves.toEqual(["wrun_1"]);
});

test("a Db is the Postgres store: every operation is a statement against it", async () => {
  const db = recordingDb();
  const store = resolveKeyStore(db);
  await store.record("intake", "caller-7", "wrun_1");
  expect(db.sql).toContainEqual(expect.stringContaining("create table if not exists"));
  expect(db.issued.some((statement) => statement.params.includes("wrun_1"))).toBe(true);
});
