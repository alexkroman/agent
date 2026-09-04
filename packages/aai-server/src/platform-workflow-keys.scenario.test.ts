// Copyright 2026 the AAI authors. MIT license.
/**
 * Does the PLATFORM's correlation-key index hold, on a real Postgres?
 *
 * `aai-runtime/workflow-keys-conformance-postgres.scenario.test.ts` asks the same
 * questions of the SELF-HOSTED store, and `workflow-keys.scenario.test.ts` beside
 * this one asserts that store's DDL and plan. Both stay: they run different SQL
 * against a different schema, and the whole design rests on the two agreeing.
 * This is the tier a DEPLOYED run actually uses.
 *
 * Five things only this tier can answer, and the last two exist only here:
 *
 * - **`on conflict (slug, run_id) do nothing` is a no-op only if the primary key
 *   really is `(slug, run_id)`.** A statement recorder replays the text and cannot
 *   know whether the constraint it names exists — and that clause is the whole of
 *   this contract's idempotency, which is where both of the drifts the shared case
 *   list found lived.
 * - **`order by created_at desc, run_id desc` is what makes "newest first" true**,
 *   including for two runs recorded in the same millisecond, where the ULID
 *   tiebreak is a claim about the SERVER's collation.
 * - **`limit $4` is a bind parameter** Postgres resolves to `bigint`, which is a
 *   driver question a `slice` cannot be wrong about.
 * - **TENANCY**, which the self-hosted store has no version of. Every statement
 *   carries a slug taken from the bearer, and the claim is that a guessed run id
 *   or a shared key reaches nothing across the boundary. That is a claim about
 *   column values in a shared table, so only a real database holding two tenants'
 *   rows can test it — and the failure it prevents is one agent resuming another's
 *   run.
 * - **RETENTION**, which is a whole pg_cron body nothing else executes. The key
 *   index is the one child of a run that `sweep_terminal_workflow_runs` cannot
 *   delete, so `SWEEP_WORKFLOW_RUN_KEYS` is what stops the table growing forever;
 *   its predicate is an anti-join against `workflow_runs` plus an age prefilter,
 *   and both halves are answers only a database can give.
 *
 * **It owns its DATABASE, because that last predicate is FLEET-WIDE.** The sweep
 * deletes every orphan in the table, whatever slug wrote it, so a slug cannot
 * isolate this suite from a sibling and vitest runs files in parallel — the rule
 * `useThrowawayPlatformDb` was written for, and its doc carries the two measured
 * flakes behind it.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgres://postgres@127.0.0.1:5432/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { beforeEach, expect, test } from "vitest";
import { describeWithPg } from "./_pg-test-utils.ts";
import { useThrowawayPlatformDb } from "./_workflow-queue-test-utils.ts";
import { platformCronJobs } from "./pg-cron.ts";
import * as keys from "./platform-workflow-keys.ts";
import type { SqlExec } from "./secret-store.ts";

/** Two tenants, so every read can be asked whether it crosses. */
const SLUG = "wfk-tenant";
const OTHER = "wfk-neighbour";

/** Crockford base32, ULID's alphabet: no I, L, O or U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A real ULID-SHAPED id: 10 characters of millisecond timestamp, then 16 of
 * randomness — here CHOSEN rather than random, so a case can say which of two ids
 * minted in the same millisecond was minted second.
 *
 * The shape is the whole premise of the tiebreak: a run id sorts
 * lexicographically by generation time. A uuid would tie-break to nonsense and
 * the case would still pass.
 */
function ulid(ms: number, tail: string): string {
  let time = "";
  let n = ms;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD.charAt(n % 32) + time;
    n = Math.floor(n / 32);
  }
  return `${time}${tail.padStart(16, "0")}`;
}

describeWithPg("the platform's correlation-key index over a real Postgres", () => {
  const own = useThrowawayPlatformDb("wfkeys");
  /** A connection whose planner cannot use an index — see the tiebreak case. */
  let sortingDb: ReturnType<typeof createPostgresDb> | undefined;

  const sql = (): SqlExec => own.sql();

  /**
   * The columns the shipped `agents` table really requires — every NOT NULL with
   * no default. Listed rather than derived, so a new required column fails HERE
   * instead of this suite silently testing a shape the migration does not have.
   */
  const seedAgent = (slug: string) =>
    sql()(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
      [slug],
    );

  beforeEach(async () => {
    // The database is this suite's own, so a full wipe is the cheapest isolation
    // and the only one the fleet-wide sweep case can rely on.
    await sql()("delete from aai_platform.agents");
    await seedAgent(SLUG);
    await seedAgent(OTHER);
  });

  /** A run row, so a key can be given a live parent for the retention cases. */
  const seedRun = (slug: string, runId: string, createdAt = Date.now()) =>
    sql()(
      `insert into aai_platform.workflow_runs
         (slug, run_id, workflow, status, created_at)
       values ($1, $2, 'digest', 'completed', $3)`,
      [slug, runId, createdAt],
    );

  const record = (
    slug: string,
    runId: string,
    key = "+14155550123",
    createdAt = Date.now(),
    workflow = "digest",
  ) => keys.recordKey(sql(), slug, { runId, workflow, key, createdAt });

  test("a recorded run is reachable by its key", async () => {
    // The case the whole feature exists for: the run outlives the session that
    // started it, so this is how the caller's NEXT call finds it.
    await record(SLUG, "wrun_1");
    expect(await keys.lookupKey(sql(), SLUG, "digest", "+14155550123", 20)).toEqual(["wrun_1"]);
  });

  test("several runs under one key come back NEWEST FIRST", async () => {
    // `order by created_at desc`. The rows are inserted oldest-first, so the
    // physical heap order is the WRONG answer and an `order by` that was dropped
    // would show up here.
    const base = Date.now();
    for (const [i, runId] of ["wrun_a", "wrun_b", "wrun_c"].entries()) {
      await record(SLUG, runId, "caller", base + i);
    }
    expect(await keys.lookupKey(sql(), SLUG, "digest", "caller", 20)).toEqual([
      "wrun_c",
      "wrun_b",
      "wrun_a",
    ]);
  });

  test("two runs of the SAME millisecond come back newest-first, by the ULID tiebreak", async () => {
    // The claim `, run_id desc` exists for. `created_at` is the engine's own
    // number here rather than a transaction timestamp, so the collision is FORCED
    // by sending one value — which is the honest shape: two `start` calls in one
    // millisecond really do send the same stamp.
    const at = 1_770_000_030_000;
    const started = ["0001", "0009", "000A", "000Z"].map((tail) => ulid(at, tail));
    for (const runId of started) await record(SLUG, runId, "tie", at);

    // Descending ULID order IS "the order they were started", which is the
    // contract. Spelled as a JS sort of the same ids rather than as a literal, so
    // the assertion is that the SERVER's collation agrees with ULID's ordering
    // rather than that both agree with something typed by hand.
    const newestFirst = [...started].sort().reverse();
    expect(await keys.lookupKey(sql(), SLUG, "digest", "tie", 20)).toEqual(newestFirst);

    // And on a plan that has to SORT. This is the arm the tiebreak really lives
    // in: `workflow_run_keys_lookup_idx` already carries `created_at desc, run_id
    // desc`, so an index scan answers correctly whether or not the query asked —
    // deleting `, run_id desc` from the statement leaves every case above passing.
    const noIndex = ["enable_indexscan", "enable_indexonlyscan", "enable_bitmapscan"]
      .map((guc) => `%20-c%20${guc}%3Doff`)
      .join("");
    sortingDb = createPostgresDb({ url: `${own.url()}?options=${noIndex.slice(3)}`, max: 1 });
    const sorted = await keys.lookupKey(
      (query, params) => sortingDb?.query(query, params) ?? Promise.resolve([]),
      SLUG,
      "digest",
      "tie",
      20,
    );
    await sortingDb.close();
    sortingDb = undefined;
    expect(sorted).toEqual(newestFirst);
  });

  test("the limit keeps the NEWEST, and reaches Postgres as a bind parameter", async () => {
    const base = Date.now();
    for (const [i, runId] of ["wrun_a", "wrun_b", "wrun_c"].entries()) {
      await record(SLUG, runId, "caller", base + i);
    }
    expect(await keys.lookupKey(sql(), SLUG, "digest", "caller", 2)).toEqual(["wrun_c", "wrun_b"]);
    // `limit 0` is an empty page and not "unlimited" — the reading the shared
    // conformance case pins across all three backends.
    expect(await keys.lookupKey(sql(), SLUG, "digest", "caller", 0)).toEqual([]);
  });

  test("re-recording a run is a NO-OP, not a second row and not a move", async () => {
    // What a retried `record` after a lost connection sends. `on conflict (slug,
    // run_id) do nothing` is a no-op only if the primary key is really on that
    // pair, which is what this tier is for — and first-write-wins has to hold for
    // the ORDER too: a late retry of an older run must not promote it.
    const base = Date.now();
    await record(SLUG, "wrun_old", "caller", base);
    await record(SLUG, "wrun_new", "caller", base + 1);
    await record(SLUG, "wrun_old", "caller", base + 2);
    expect(await keys.lookupKey(sql(), SLUG, "digest", "caller", 20)).toEqual([
      "wrun_new",
      "wrun_old",
    ]);
  });

  test("a run recorded under a SECOND key keeps the first, and joins no other", async () => {
    // The run id is the key, so the first key a run was recorded under is the only
    // one that ever finds it. Unreachable through `start()`, which records once;
    // asserted because "unreachable" is what the interface's next caller does not
    // know.
    await record(SLUG, "wrun_1", "first-key");
    await record(SLUG, "wrun_1", "second-key");
    expect(await keys.lookupKey(sql(), SLUG, "digest", "first-key", 20)).toEqual(["wrun_1"]);
    expect(await keys.lookupKey(sql(), SLUG, "digest", "second-key", 20)).toEqual([]);
  });

  test("an EMPTY key is a key, not absence", async () => {
    // Reachable: a withheld caller ID. The route reads `key` with a reader that
    // accepts `""` for exactly this reason, and the column is `text not null`.
    await record(SLUG, "wrun_1", "");
    expect(await keys.lookupKey(sql(), SLUG, "digest", "", 20)).toEqual(["wrun_1"]);
  });

  test("the index is keyed on the pair, so another WORKFLOW's key answers empty", async () => {
    await record(SLUG, "wrun_1", "caller", Date.now(), "digest");
    expect(await keys.lookupKey(sql(), SLUG, "recap", "caller", 20)).toEqual([]);
  });

  test("a neighbour's run is not reachable by its key, or by any key", async () => {
    // THE tenancy claim. Both tenants record the same key — a phone number is not
    // a secret — and each must see only its own run. A statement missing
    // `slug = $1` passes every case above and fails here.
    await record(SLUG, "wrun_mine", "+14155550123");
    await record(OTHER, "wrun_theirs", "+14155550123");
    expect(await keys.lookupKey(sql(), SLUG, "digest", "+14155550123", 20)).toEqual(["wrun_mine"]);
    expect(await keys.lookupKey(sql(), OTHER, "digest", "+14155550123", 20)).toEqual([
      "wrun_theirs",
    ]);
  });

  test("a neighbour recording the SAME run id takes nothing from this tenant", async () => {
    // The primary key leads with the slug, so one run id is two rows here. Keyed
    // on `run_id` alone — the self-hosted store's shape — the second `record`
    // would be a no-op and the second tenant's key would find nothing.
    await record(SLUG, "wrun_shared", "mine");
    await record(OTHER, "wrun_shared", "theirs");
    expect(await keys.lookupKey(sql(), SLUG, "digest", "mine", 20)).toEqual(["wrun_shared"]);
    expect(await keys.lookupKey(sql(), OTHER, "digest", "theirs", 20)).toEqual(["wrun_shared"]);
  });

  test("deleting the AGENT takes its keys with it, and leaves the neighbour's", async () => {
    // The cascade, which is the whole of what an agent delete has to do here —
    // `deleteAgent` grows no step for this table, and `pg-cron-delete-parity.test.ts`
    // would fail if it did.
    await record(SLUG, "wrun_mine", "caller");
    await record(OTHER, "wrun_theirs", "caller");
    await sql()("delete from aai_platform.agents where slug = $1", [SLUG]);
    expect(await keys.lookupKey(sql(), SLUG, "digest", "caller", 20)).toEqual([]);
    expect(await keys.lookupKey(sql(), OTHER, "digest", "caller", 20)).toEqual(["wrun_theirs"]);
  });

  test("a key may name a run this schema has never seen", async () => {
    // A contract point rather than a curiosity: `WorkflowKeyStore.record` promises
    // nothing about a run existing, and the memory and self-hosted arms accept an
    // arbitrary id — so a foreign key to `workflow_runs` here would make the
    // platform arm refuse what the other two store. This is the assertion that
    // fails the day somebody adds one.
    await expect(record(SLUG, "wrun_no_such_run", "caller")).resolves.toBeNull();
    expect(await keys.lookupKey(sql(), SLUG, "digest", "caller", 20)).toEqual(["wrun_no_such_run"]);
  });

  /** The retention sweep's own body, as `platformCronJobs()` declares it. */
  const sweep = (): string =>
    platformCronJobs().find((job) => job.name === "aai-sweep-workflow-run-keys")?.command ?? "";

  test("the retention sweep is declared, and its body EXECUTES", async () => {
    // `pg-cron.test.ts` asserts a body reached `cron.schedule` as a string, which
    // stores the text without parsing it — so a syntax error or a renamed column
    // is green there and wrong hourly in production. (The general version of this
    // is `pg-cron.scenario.test.ts`, which needs the whole Supabase stack; this
    // arm runs on a plain Postgres.)
    expect(sweep()).toContain("aai_platform.workflow_run_keys");
    await expect(sql()(sweep())).resolves.toBeDefined();
  });

  test("it collects a key whose run is GONE, and keeps one whose run is live", async () => {
    // The predicate, both directions in one case because the wrong half passing
    // alone is what a one-sided assertion cannot see. Old enough to clear the age
    // prefilter: 40 days back, against a 30-day prefilter.
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await seedRun(SLUG, "wrun_live", old);
    await record(SLUG, "wrun_live", "live-caller", old);
    await record(SLUG, "wrun_reaped", "gone-caller", old);

    await sql()(sweep());

    expect(await keys.lookupKey(sql(), SLUG, "digest", "gone-caller", 20)).toEqual([]);
    expect(await keys.lookupKey(sql(), SLUG, "digest", "live-caller", 20)).toEqual(["wrun_live"]);
  });

  test("it leaves a RECENT orphan alone, which is the prefilter doing its job", async () => {
    // A key is written moments before the journal's own `createRun` lands in the
    // ordinary case — and more to the point, the age half is what keeps a no-op
    // pass an index probe. A sweep with no prefilter would collect this row, so
    // this is the case that fails if the age predicate is dropped.
    await record(SLUG, "wrun_fresh", "fresh-caller", Date.now());
    await sql()(sweep());
    expect(await keys.lookupKey(sql(), SLUG, "digest", "fresh-caller", 20)).toEqual(["wrun_fresh"]);
  });

  test("it collects across tenants, and only the orphans", async () => {
    // The sweep is fleet-wide by construction (it has no slug to lead with), which
    // is both why this suite owns its database and a property worth pinning: a
    // predicate that accidentally scoped itself to one tenant would leave every
    // other tenant's table growing forever.
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await seedRun(OTHER, "wrun_live", old);
    await record(OTHER, "wrun_live", "live-caller", old);
    await record(OTHER, "wrun_reaped", "gone-caller", old);
    await record(SLUG, "wrun_reaped_too", "gone-caller", old);

    await sql()(sweep());

    expect(await keys.lookupKey(sql(), OTHER, "digest", "gone-caller", 20)).toEqual([]);
    expect(await keys.lookupKey(sql(), SLUG, "digest", "gone-caller", 20)).toEqual([]);
    expect(await keys.lookupKey(sql(), OTHER, "digest", "live-caller", 20)).toEqual(["wrun_live"]);
  });
});
