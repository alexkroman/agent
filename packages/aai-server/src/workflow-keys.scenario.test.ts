// Copyright 2026 the AAI authors. MIT license.
/**
 * Does the correlation-key index really work on a real Postgres?
 *
 * `createPostgresKeyStore` (`aai/host/workflow-keys.ts`) is the index that makes
 * a durable run reachable from the NEXT phone call — the case the whole feature
 * exists for. Its unit spec drives it against a recording `Db` and says so
 * outright: what a recorder can see is the SHAPE of the work (which statements
 * were issued, in what order, with which parameters), and it says a real pass
 * "belongs in the integration tier". This is that pass, and it is the only tier
 * that can answer four things:
 *
 * - **The DDL is a STRING to a recorder.** `create table if not exists …` and
 *   the four-column `create index` are asserted today by `toContain`, so a
 *   syntax error in either is green — the `pg-cron.scenario.test.ts` lesson
 *   verbatim ("asserts only that the body reached `cron.schedule` as a string").
 * - **`on conflict (run_id) do nothing` is a no-op only if the primary key
 *   really is on `run_id`.** A recorder replays the statement text and cannot
 *   know whether the constraint it names exists.
 * - **The ULID tiebreak is a claim about the DATABASE, not about the query.**
 *   That `order by created_at desc, run_id desc` returns two runs of the same
 *   millisecond newest-first depends on `timestamptz` comparing equal at that
 *   resolution and on the server's collation sorting ULID text the way ULID's
 *   own spec says it sorts. Neither is representable in JS.
 * - **`limit $3` is a bigint parameter**, which is a driver question.
 *
 * The millisecond collision is FORCED rather than raced: `now()` is the
 * transaction's timestamp and each `record` is its own transaction, so two
 * inserts cannot be made to collide on demand. What is under test is what the
 * `order by` does once they have — which is the part that was never run.
 *
 * `WORKFLOW_KEYS_TABLE` is not on a published subpath, so the table is
 * DISCOVERED from the schema instead of named. That is stricter, not weaker: the
 * schema is this file's own and the key store is the only thing that writes to
 * it, so "exactly one table, and here is its name" is an assertion about the DDL
 * having run rather than a restatement of a constant.
 *
 * Self-cleaning: one schema, created and dropped by this file.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:5432/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { createPostgresDb, createPostgresKeyStore } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";

/**
 * NOT app-shaped (`app_` + 16 hex), deliberately — the platform's TTL sweep
 * walks every app-shaped schema, and this file's tables are none of its
 * business. It is also distinct from every other scenario suite's schema so the
 * tier can run its files in one process.
 */
const SCHEMA = "wf_keys_scenario";

/** Crockford base32, ULID's alphabet: no I, L, O or U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A real ULID-SHAPED id: 10 characters of millisecond timestamp, then 16 of
 * randomness — here chosen rather than random, so a test can say which of two
 * ids generated in the same millisecond was generated second.
 *
 * The shape matters because the tiebreak's whole premise is that a run id sorts
 * lexicographically by generation time. A uuid would tie-break to nonsense and
 * the test would still pass.
 */
function ulid(ms: number, tail: string): string {
  let time = "";
  let n = ms;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD.charAt(n % 32) + time;
    n = Math.floor(n / 32);
  }
  return time + tail.padStart(16, "0");
}

/**
 * Ids from ONE millisecond, in the order they would have been generated.
 *
 * Every test takes its own millisecond, because `run_id` is the primary key of a
 * table this whole file shares: an id reused across tests is silently swallowed
 * by `on conflict do nothing`, which would make a later case assert over rows
 * an earlier one owns.
 */
function sameMillis(ms: number, ...tails: string[]): string[] {
  return tails.map((tail) => ulid(ms, tail));
}

describeWithPg("the workflow correlation-key index over a real Postgres", () => {
  let db: ReturnType<typeof createPostgresDb>;
  let sql: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;
  /** A handle whose search_path is the test schema, as a guest's own role is. */
  let appDb: ReturnType<typeof createPostgresDb>;
  let store: ReturnType<typeof createPostgresKeyStore>;
  /**
   * The same schema, on a connection that cannot use an index.
   *
   * The lookup index is `(workflow, key, created_at desc, run_id desc)`, so an
   * index scan RETURNS the tiebreak whether or not the query asks for it — which
   * makes the ordering clause untestable on the plan the planner actually picks
   * for a small table. This handle forces the sort, which is what the same query
   * gets on a table created by an SDK version that predates the index, on a
   * parallel plan, and any time the planner prefers a seq scan. The claim under
   * test is that the ANSWER does not depend on the plan.
   */
  let sortingDb: ReturnType<typeof createPostgresDb>;
  let sortingStore: ReturnType<typeof createPostgresKeyStore>;

  beforeAll(async () => {
    db = createPostgresDb({ url: pgUrl() });
    sql = db.query;
    await sql(`drop schema if exists ${SCHEMA} cascade`);
    await sql(`create schema ${SCHEMA}`);
    // `search_path` rather than a qualified table name: that is how the platform
    // provisions an app role, so the store's unqualified SQL is exercised the way
    // a guest runs it.
    appDb = createPostgresDb({ url: `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}` });
    store = createPostgresKeyStore(appDb);
    const noIndex = ["enable_indexscan", "enable_indexonlyscan", "enable_bitmapscan"]
      .map((guc) => `%20-c%20${guc}%3Doff`)
      .join("");
    sortingDb = createPostgresDb({
      url: `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}${noIndex}`,
    });
    sortingStore = createPostgresKeyStore(sortingDb);
  });

  afterAll(async () => {
    await sortingDb.close();
    await appDb.close();
    await sql(`drop schema if exists ${SCHEMA} cascade`);
    await db.close();
  });

  /**
   * Every table in this schema — the DDL's own output, not a constant.
   *
   * The key store is the only thing that writes here, so the LIST is the
   * assertion: one table means the `create table` ran and created exactly what
   * it names, and its name is then available without importing a constant that
   * is not on a published subpath.
   */
  const tables = (): Promise<{ table_name: string }[]> =>
    sql<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = $1",
      [SCHEMA],
    );

  /** The one table's name, for a statement that has to qualify it. */
  const tableName = async (): Promise<string> => (await tables())[0]?.table_name ?? "";

  test("the DDL really executes, and a second store over the same database re-runs it safely", async () => {
    // A syntax error anywhere in either statement fails HERE and nowhere else:
    // the unit spec asserts the text, which is the same green either way.
    const [first, later] = sameMillis(1_770_000_000_000, "0001", "0002");
    await store.record("wf-ddl", "k", first ?? "");
    const created = await tables();
    expect(created).toHaveLength(1);
    expect(created[0]?.table_name).toMatch(/^aai_/);

    // `ensureOnce` memoizes per STORE, so a second store over the same database
    // issues `create table if not exists` again — the case the lazy-DDL design
    // depends on and the one a recorder can only assert as a string.
    const second = createPostgresKeyStore(appDb);
    await second.record("wf-ddl", "k", later ?? "");
    expect(await tables()).toEqual(created);
    expect(await second.lookup("wf-ddl", "k", 10)).toEqual([later, first]);
  });

  test("the lookup index exists, on the four columns the lookup orders by", async () => {
    // Without it a lookup on a busy agent degrades to a full scan of every run
    // the agent has ever started. Nothing above this tier can see whether the
    // `create index` statement was accepted at all.
    await store.record("wf-index", "k", ulid(1_770_000_010_000, "0001"));
    const table = await tableName();
    const rows = await sql<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = $1 and indexname = $2",
      [SCHEMA, `${table}_lookup`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("(workflow, key, created_at DESC, run_id DESC)");
  });

  test("a recorded run is found by its key, and an unknown key finds nothing", async () => {
    const runId = ulid(1_770_000_020_000, "0001");
    await store.record("wf-round", "+14155550123", runId);
    expect(await store.lookup("wf-round", "+14155550123", 20)).toEqual([runId]);
    expect(await store.lookup("wf-round", "+14155550199", 20)).toEqual([]);
    expect(await store.lookup("wf-other", "+14155550123", 20)).toEqual([]);
  });

  test("two runs of the SAME millisecond come back newest-first, by the ULID tiebreak", async () => {
    // The claim the module doc makes and nothing has ever run. Recorded in
    // ascending id order, so the physical order of the heap is the WRONG answer:
    // if `run_id desc` is dropped the rows come back oldest-first.
    const started = sameMillis(1_770_000_030_000, "0001", "0009", "000A", "000Z");
    for (const runId of started) await store.record("wf-tie", "caller", runId);
    const table = await tableName();
    await sql(`update ${SCHEMA}.${table} set created_at = $1 where workflow = $2`, [
      new Date(1_770_000_030_000),
      "wf-tie",
    ]);

    // Every row's `created_at` is now byte-identical, so the tiebreak is the only
    // thing left that can decide — which is what a same-millisecond pair is.
    const times = await sql<{ n: number }>(
      `select count(distinct created_at)::int as n from ${SCHEMA}.${table} where workflow = $1`,
      ["wf-tie"],
    );
    expect(times[0]?.n).toBe(1);

    // Descending ULID order IS "the order they were started", which is the
    // contract. Spelled as a JS sort of the same ids rather than as a literal, so
    // the assertion is that the SERVER's collation agrees with ULID's ordering
    // rather than that both agree with something typed by hand.
    const newestFirst = [...started].sort().reverse();
    expect(await store.lookup("wf-tie", "caller", 20)).toEqual(newestFirst);
    // And on a plan that has to SORT. This is the arm the tiebreak lives in:
    // the index already encodes `run_id desc`, so an index scan answers
    // correctly even for a query that never asked — drop `, run_id desc` from
    // the lookup and only this line goes red, oldest-first.
    expect(await sortingStore.lookup("wf-tie", "caller", 20)).toEqual(newestFirst);
  });

  test("created_at still dominates the tiebreak", async () => {
    // The other half of the same clause: a run started later wins even when its
    // id sorts lower, so an `order by run_id desc` alone would be wrong too.
    const older = ulid(1_770_000_000_000, "ZZZZ");
    const newer = ulid(1_770_000_060_000, "0001");
    await store.record("wf-clock", "caller", older);
    await store.record("wf-clock", "caller", newer);
    const table = await tableName();
    await sql(`update ${SCHEMA}.${table} set created_at = $1 where run_id = $2`, [
      new Date(1_770_000_000_000),
      older,
    ]);
    await sql(`update ${SCHEMA}.${table} set created_at = $1 where run_id = $2`, [
      new Date(1_770_000_060_000),
      newer,
    ]);
    expect(await store.lookup("wf-clock", "caller", 20)).toEqual([newer, older]);
  });

  test("re-recording the same run id is a no-op rather than an error", async () => {
    // What a retried `record` after a lost connection sends. `on conflict
    // (run_id) do nothing` is only a no-op if the primary key really is on
    // `run_id`, which is a property of the DDL and not of the insert.
    const runId = ulid(1_770_000_100_000, "0007");
    await store.record("wf-retry", "caller", runId);
    await expect(store.record("wf-retry", "caller", runId)).resolves.toBeUndefined();
    // A DIFFERENT key for the same run: `do nothing` must keep the first, where
    // an upsert would rewrite it and a plain insert would raise.
    await expect(store.record("wf-retry", "someone-else", runId)).resolves.toBeUndefined();

    const table = await tableName();
    const rows = await sql<{ key: string }>(
      `select key from ${SCHEMA}.${table} where run_id = $1`,
      [runId],
    );
    expect(rows.map((r) => r.key)).toEqual(["caller"]);
  });

  test("the same key under two workflows stays apart", async () => {
    // The lookup is on the PAIR, and a name is what survives a redeploy — so two
    // workflows sharing a caller's phone number must not see each other's runs.
    const a = ulid(1_770_000_200_000, "000A");
    const b = ulid(1_770_000_200_000, "000B");
    await store.record("wf-left", "+14155550000", a);
    await store.record("wf-right", "+14155550000", b);
    expect(await store.lookup("wf-left", "+14155550000", 20)).toEqual([a]);
    expect(await store.lookup("wf-right", "+14155550000", 20)).toEqual([b]);
  });

  test("the limit is honoured, as a real bind parameter", async () => {
    // `limit $3` is sent as a parameter, which Postgres resolves to bigint — the
    // driver-level half of a clamp whose JS half `resolveFindLimit` owns.
    const ids = ["0001", "0002", "0003", "0004", "0005"].map((tail) =>
      ulid(1_770_000_300_000, tail),
    );
    for (const runId of ids) await store.record("wf-limit", "caller", runId);
    const table = await tableName();
    await sql(`update ${SCHEMA}.${table} set created_at = $1 where workflow = $2`, [
      new Date(1_770_000_300_000),
      "wf-limit",
    ]);

    expect(await store.lookup("wf-limit", "caller", 2)).toEqual([ids[4], ids[3]]);
    expect(await store.lookup("wf-limit", "caller", 1)).toEqual([ids[4]]);
    expect(await store.lookup("wf-limit", "caller", 100)).toHaveLength(5);
  });
});
