// Copyright 2026 the AAI authors. MIT license.
/**
 * Does `createDbSessionStore` actually work against Postgres?
 *
 * It did not, and the way it failed is the reason this file exists. The write
 * bound the snapshot as JSON text with a bare `$n::jsonb` cast; postgres.js
 * resolves the parameter's type from that cast and JSON-encodes the string we
 * had already encoded, so the column held a jsonb *string*. `load` then read a
 * string where it expected an object and answered "no snapshot" — durable
 * resume restoring NOTHING, in production, with all twenty unit tests green.
 *
 * **No test with a fake `Db` could have caught it**, which is the whole point:
 * a fake round-trips JS objects, so a double-encoded write is unrepresentable
 * in it. The bug lives strictly in the driver↔Postgres seam. The platform's own
 * stores paid for this once already — see
 * `aai-server/jsonb-encoding.integration.test.ts`, whose finding this
 * reproduced verbatim.
 *
 * Self-cleaning: everything is written under a table this file owns and drops
 * afterwards, so it is safe against a shared database (but do NOT point it at
 * production).
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 *   pnpm --filter @alexkroman1/aai test:integration
 * ```
 */

import { afterAll, describe, expect, test } from "vitest";
import { createPostgresDb } from "../postgres-db.ts";
import { createDbSessionStore } from "../session-store.ts";

const PG_URL = process.env.AAI_TEST_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;
const TABLE = "aai_session_state_itest";

describeIfPg("createDbSessionStore against a real Postgres", () => {
  const db = createPostgresDb({ url: PG_URL ?? "" });
  const store = createDbSessionStore({ db, table: TABLE });

  afterAll(async () => {
    await db.query(`drop table if exists ${TABLE}`).catch(() => undefined);
    await db.close();
  });

  test("round-trips a snapshot through the column", async () => {
    await store.save("s1", { state: { cart: ["apple"], n: 2 }, providerSessionId: "prov-1" });
    await expect(store.load("s1")).resolves.toEqual({
      state: { cart: ["apple"], n: 2 },
      providerSessionId: "prov-1",
    });
  });

  test("the column holds an OBJECT, not a jsonb string", async () => {
    // The assertion the unit suite structurally cannot make, and the one that
    // fails on a bare `$n::jsonb` bind: `jsonb_typeof` reports 'string' for a
    // double-encoded write and 'object' for a correct one.
    await store.save("s2", { state: { a: 1 } });
    const rows = await db.query<{ kind: string }>(
      `select jsonb_typeof(snapshot) as kind from ${TABLE} where session_id = $1`,
      ["s2"],
    );
    expect(rows[0]?.kind).toBe("object");
  });

  test("a second save replaces rather than duplicating (the upsert)", async () => {
    await store.save("s3", { state: { n: 1 } });
    await store.save("s3", { state: { n: 2 } });
    const rows = await db.query<{ count: string }>(
      `select count(*)::text as count from ${TABLE} where session_id = $1`,
      ["s3"],
    );
    expect(rows[0]?.count).toBe("1");
    await expect(store.load("s3")).resolves.toEqual({ state: { n: 2 } });
  });

  test("an expired row is not served, and the interval bind really parses", async () => {
    // `($n || ' milliseconds')::interval` is the other statement no fake can
    // check: a parameter Postgres cannot type resolves to an error here, not
    // in a unit test.
    const brief = createDbSessionStore({ db, table: TABLE, ttlMs: 1 });
    await brief.save("s4", { state: { n: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(brief.load("s4")).resolves.toBeNull();
  });

  test("delete removes the row, and a miss reads as null", async () => {
    await store.save("s5", { state: {} });
    await store.delete("s5");
    await expect(store.load("s5")).resolves.toBeNull();
    await expect(store.load("never-written")).resolves.toBeNull();
  });
});
