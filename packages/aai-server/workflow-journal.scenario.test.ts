// Copyright 2026 the AAI authors. MIT license.
/**
 * Does the durable journal really hold, on a real Postgres?
 *
 * `createPostgresJournal` (`aai-runtime/workflow-journal-postgres.ts`) is what
 * makes a run outlive its process, and almost everything interesting about it is
 * a claim about the DATABASE rather than about the code. Its memory twin gets
 * atomicity by not awaiting mid-operation; here each of those is one statement
 * the server has to make atomic on its own, and a unit test with a recording
 * `Db` can only assert the statement TEXT — which is the
 * `pg-cron.scenario.test.ts` lesson verbatim: a syntax error in a string is
 * green.
 *
 * Five things only this tier can answer, and each is a way a run looks healthy
 * while being wrong:
 *
 * - **`claimAttempt` is `insert … on conflict do update set n = n + 1
 *   returning n`.** Whether two concurrent claims get 1 and 2 rather than 1 and
 *   1 is a statement about row locking. Read-then-write would let a step exceed
 *   its ceiling and retry forever.
 * - **`setStatus`'s compare-and-set is a `where` clause**, and its row count is
 *   the answer. If the predicate does not really constrain, a worker that had
 *   not noticed a cancel marks the run completed.
 * - **`appendStep`'s `on conflict do nothing` is a no-op only if the primary key
 *   really is `(run_id, key)`.** A recorder replays the text and cannot know
 *   whether the constraint it names exists — so the loser of a race would insert
 *   a second entry and the two replays would diverge.
 * - **A hook token is UNIQUE across every run.** That is an index, not a check
 *   in JS, and it is what turns two waits sharing a token into a refusal rather
 *   than a signal ending whichever row the planner reached first.
 * - **`bigint` comes back as a STRING.** Every timestamp here would be a
 *   `"1756..." < "1756..."` string comparison if `millis()` were dropped, and
 *   `listRuns`' ordering would be right by accident.
 *
 * It also runs the DDL, which is the other thing a recorder cannot: six
 * statements including an index, asserted today by nothing.
 *
 * Self-cleaning: one schema, created and dropped by this file.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:5432/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { applyWorkflowJournalDdl, createPostgresJournal } from "@alexkroman1/aai-runtime/internal";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";

/**
 * NOT app-shaped (`app_` + 16 hex), for the reason `workflow-keys.scenario.test.ts`
 * gives: the platform's TTL sweep walks every app-shaped schema and this file's
 * tables are none of its business. Distinct from every other scenario suite's
 * schema so the tier can run its files in one process.
 */
const SCHEMA = "wf_journal_scenario";

/** Silent — this suite asserts behaviour, not lines. */
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describeWithPg("the durable workflow journal over a real Postgres", () => {
  let db: ReturnType<typeof createPostgresDb>;
  let sql: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;
  /** A handle whose search_path is the test schema, as a guest's own role is. */
  let appDb: ReturnType<typeof createPostgresDb>;
  let journal: ReturnType<typeof createPostgresJournal>;
  /** Whether the DDL ran, asserted by the first test rather than in the hook. */
  let ddlApplied = false;

  beforeAll(async () => {
    db = createPostgresDb({ url: pgUrl() });
    sql = db.query;
    await sql(`drop schema if exists ${SCHEMA} cascade`);
    await sql(`create schema ${SCHEMA}`);
    // `search_path` rather than qualified names: that is how the platform
    // provisions an app role, so the journal's unqualified SQL runs the way a
    // guest runs it.
    appDb = createPostgresDb({ url: `${pgUrl()}?options=-c%20search_path%3D${SCHEMA}` });
    journal = createPostgresJournal({ db: appDb });
    // The DDL, EXECUTED rather than asserted as a string. Its result is carried
    // to a test rather than asserted here: an `expect` in a hook is
    // `noMisplacedAssertion`, and a failure there reports as a suite that could
    // not start rather than as the claim that failed.
    ddlApplied = await applyWorkflowJournalDdl({ db: appDb, logger });
  });

  afterAll(async () => {
    await appDb.close();
    await sql(`drop schema if exists ${SCHEMA} cascade`);
    await db.close();
  });

  /** A fresh run id per call, for the cases that need several. */
  let seq = 0;
  const nextRun = () => `wrun_seq${++seq}`;

  /** A fresh run, so each test owns its own rows. */
  async function seed(runId: string, workflow = "digest"): Promise<void> {
    await journal.createRun({
      runId,
      workflow,
      status: "pending",
      createdAt: Date.now(),
      input: { topic: "otters" },
    });
  }

  test("the DDL applies and creates exactly the five tables the journal writes", async () => {
    expect(ddlApplied).toBe(true);
    const rows = await sql<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = $1 order by 1",
      [SCHEMA],
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "aai_workflow_attempt_leases",
      "aai_workflow_hooks",
      "aai_workflow_runs",
      "aai_workflow_sleeps",
      "aai_workflow_steps",
    ]);
  });

  test("a run round-trips, and a `bigint` timestamp comes back as a NUMBER", async () => {
    const createdAt = Date.now();
    await journal.createRun({
      runId: "wrun_rt",
      workflow: "digest",
      status: "pending",
      createdAt,
      input: { topic: "otters" },
    });
    const record = await journal.getRun("wrun_rt");
    expect(record).toMatchObject({ runId: "wrun_rt", workflow: "digest", status: "pending" });
    // The driver hands `bigint` back as a string; unconverted, every comparison
    // downstream would be lexicographic and right by accident.
    expect(typeof record?.createdAt).toBe("number");
    expect(record?.createdAt).toBe(createdAt);
    expect(record?.input).toEqual({ topic: "otters" });
  });

  test("refuses a duplicate run id, so two racing starts cannot both win", async () => {
    await seed("wrun_dupe");
    await expect(seed("wrun_dupe")).rejects.toThrow();
  });

  test("carries a Uint8Array and a Date through the codec", async () => {
    // `JSON.stringify` turns binary into an index map and nothing errors — the
    // run simply resumes with garbage. This is the one boundary that catches it.
    const at = new Date("2026-03-04T05:06:07.000Z");
    await journal.createRun({
      runId: "wrun_binary",
      workflow: "digest",
      status: "pending",
      createdAt: Date.now(),
      input: { bytes: new Uint8Array([1, 2, 250]), at },
    });
    const input = (await journal.getRun("wrun_binary"))?.input as {
      bytes: Uint8Array;
      at: Date;
    };
    expect(input.bytes).toBeInstanceOf(Uint8Array);
    expect([...input.bytes]).toEqual([1, 2, 250]);
    expect(input.at).toBeInstanceOf(Date);
    expect(input.at.getTime()).toBe(at.getTime());
  });

  test("claimAttempt increments ATOMICALLY under concurrency", async () => {
    // The claim that a read-then-write would fail: eight concurrent claims must
    // hand out eight DISTINCT numbers, or a step exceeds its ceiling and retries
    // forever.
    await seed("wrun_attempts");
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        journal.claimAttempt("wrun_attempts", "step#0", `walk-${i}`, 60_000),
      ),
    );
    expect([...claims].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("setStatus is a real compare-and-set", async () => {
    await seed("wrun_cas");
    expect(await journal.setStatus("wrun_cas", "running", undefined, ["pending"])).toBe(true);
    // The predicate really constrains: a worker that had not noticed must not
    // move a run it no longer owns.
    expect(await journal.setStatus("wrun_cas", "completed", { output: 1 }, ["pending"])).toBe(
      false,
    );
    expect((await journal.getRun("wrun_cas"))?.status).toBe("running");
  });

  test("only ONE of two concurrent terminal writes wins", async () => {
    await seed("wrun_race");
    await journal.setStatus("wrun_race", "running", undefined, ["pending"]);
    const [a, b] = await Promise.all([
      journal.setStatus("wrun_race", "completed", { output: "a" }, ["running"]),
      journal.setStatus("wrun_race", "cancelled", undefined, ["running"]),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  test("appendStep is idempotent on its key, so a raced redelivery adopts the winner", async () => {
    await seed("wrun_steps");
    const entry = {
      key: "research#0",
      name: "research",
      status: "ok" as const,
      attempts: 1,
      finishedAt: Date.now(),
    };
    const first = await journal.appendStep("wrun_steps", { ...entry, output: "winner" });
    const second = await journal.appendStep("wrun_steps", { ...entry, output: "loser" });
    expect(first.output).toBe("winner");
    // The STORED entry, not this caller's — or the two replays diverge here on.
    expect(second.output).toBe("winner");
    expect(await journal.readSteps("wrun_steps")).toHaveLength(1);
  });

  test("a sleep's wake time is decided ONCE, so a replay cannot push it out", async () => {
    await seed("wrun_sleep");
    const first = await journal.claimSleep("wrun_sleep", "sleep!0", 1000, undefined);
    const again = await journal.claimSleep("wrun_sleep", "sleep!0", 999_999, undefined);
    expect(again.wakeAt).toBe(first.wakeAt);
  });

  test("releases the run's hook TOKENS when it goes terminal", async () => {
    // Same claim as the platform store's, and it has to be tested on BOTH: they
    // are separate SQL against separate schemas, and the memory backend was the
    // only one that ever released. A derived token — `recap-workflow`'s
    // `retention:<sessionId>` — otherwise served exactly one run ever.
    const first = nextRun();
    await seed(first);
    await journal.claimHook(first, "hook!0", "retention:sess-1");
    await journal.setStatus(first, "completed");

    const second = nextRun();
    await seed(second);
    await expect(journal.claimHook(second, "hook!0", "retention:sess-1")).resolves.toMatchObject({
      token: "retention:sess-1",
    });
  });

  test("does NOT release while the run is still going", async () => {
    const runId = nextRun();
    await seed(runId);
    await journal.claimHook(runId, "hook!0", `live-${runId}`);
    await journal.setStatus(runId, "running");
    const other = nextRun();
    await seed(other);
    await expect(journal.claimHook(other, "hook!0", `live-${runId}`)).rejects.toThrow(
      /already held/,
    );
  });

  test("does not release when the compare-and-set REFUSED the move", async () => {
    // The release rides the same statement as the update, so a refused move must
    // leave the tokens alone.
    const runId = nextRun();
    await seed(runId);
    await journal.claimHook(runId, "hook!0", `refused-${runId}`);
    expect(await journal.setStatus(runId, "completed", undefined, ["running"])).toBe(false);
    const other = nextRun();
    await seed(other);
    await expect(journal.claimHook(other, "hook!0", `refused-${runId}`)).rejects.toThrow(
      /already held/,
    );
  });

  test("a bare wake reaches SLEEPS and not a hook's deadline", async () => {
    // Cutting a SCHEDULE short must not also close an approval window.
    await seed("wrun_wake");
    await journal.claimSleep("wrun_wake", "sleep!0", Date.now() + 60_000, undefined);
    await journal.claimSleep(
      "wrun_wake",
      "hookTimeout!0",
      Date.now() + 60_000,
      undefined,
      "hookTimeout",
    );

    expect(await journal.wakeSleeps("wrun_wake", undefined)).toBe(1);
    const deadline = await journal.claimSleep("wrun_wake", "hookTimeout!0", 0, undefined);
    expect(deadline.woken).toBe(false);
  });

  test("a targeted wake reaches only the wait its id names", async () => {
    await seed("wrun_wake_id");
    await journal.claimSleep("wrun_wake_id", "sleep!0", Date.now() + 60_000, "review");
    await journal.claimSleep("wrun_wake_id", "sleep!1", Date.now() + 60_000, "backoff");
    expect(await journal.wakeSleeps("wrun_wake_id", ["review"])).toBe(1);
    expect((await journal.claimSleep("wrun_wake_id", "sleep!1", 0, "backoff")).woken).toBe(false);
  });

  test("counts only the waits it actually stopped", async () => {
    await seed("wrun_wake_count");
    await journal.claimSleep("wrun_wake_count", "sleep!0", Date.now() + 60_000, undefined);
    expect(await journal.wakeSleeps("wrun_wake_count", undefined)).toBe(1);
    expect(await journal.wakeSleeps("wrun_wake_count", undefined)).toBe(0);
  });

  test("a hook token is unique across RUNS, enforced by the index", async () => {
    // A signaller knows the token and not the run, so the constraint has to be
    // global — and it is what makes a shared token a refusal rather than a signal
    // ending whichever row the planner reached first.
    await seed("wrun_hook_a");
    await seed("wrun_hook_b");
    await journal.claimHook("wrun_hook_a", "hook!0", "tok_shared");
    await expect(journal.claimHook("wrun_hook_b", "hook!0", "tok_shared")).rejects.toThrow(
      /already held by run wrun_hook_a/,
    );
  });

  test("deliverHook answers the run once, and refuses a second signal", async () => {
    await seed("wrun_deliver");
    await journal.claimHook("wrun_deliver", "hook!0", "tok_deliver");
    expect(await journal.deliverHook("tok_deliver", { ok: true })).toBe("wrun_deliver");
    // A body is replayed and must read the FIRST payload every time.
    expect(await journal.deliverHook("tok_deliver", { ok: false })).toBeUndefined();
    const record = await journal.claimHook("wrun_deliver", "hook!0", "tok_deliver");
    expect(record).toMatchObject({ delivered: true, payload: { ok: true } });
  });

  test("a CLOSED hook refuses a late signal", async () => {
    await seed("wrun_closed");
    await journal.claimHook("wrun_closed", "hook!0", "tok_closed");
    await journal.closeHook("wrun_closed", "hook!0");
    expect(await journal.deliverHook("tok_closed", { ok: true })).toBeUndefined();
  });

  test("listRuns filters by declared key and orders newest first", async () => {
    const base = Date.now();
    for (const [i, id] of ["wrun_l1", "wrun_l2", "wrun_l3"].entries()) {
      await journal.createRun({
        runId: id,
        workflow: "listing",
        status: "completed",
        createdAt: base + i,
        input: {},
      });
    }
    await journal.createRun({
      runId: "wrun_other",
      workflow: "elsewhere",
      status: "completed",
      createdAt: base + 99,
      input: {},
    });

    const rows = await journal.listRuns("listing", 10);
    expect(rows.map((r) => r.runId)).toEqual(["wrun_l3", "wrun_l2", "wrun_l1"]);
    expect(await journal.listRuns("listing", 2)).toHaveLength(2);
  });

  test("a signal that reaches no hook answers undefined rather than throwing", async () => {
    expect(await journal.deliverHook("tok_nobody_is_waiting", {})).toBeUndefined();
  });
});
