// Copyright 2026 the AAI authors. MIT license.
/**
 * Does the PLATFORM's journal hold, on a real Postgres?
 *
 * `workflow-journal.scenario.test.ts` beside this asks the same question of the
 * self-hosted store. Both are needed and neither substitutes for the other: they
 * run different SQL against different schemas, and the whole design rests on the
 * two agreeing. This one is the tier a deployed run actually uses.
 *
 * Four things only this tier can answer, and the fourth exists only here:
 *
 * - **`claimAttempt` is one `insert … on conflict do update set n = n + 1
 *   returning n`.** Whether two concurrent claims get 1 and 2 rather than 1 and 1
 *   is a statement about row locking. Read-then-write lets a step exceed its
 *   ceiling and retry forever.
 * - **`setStatus`'s compare-and-set is a `where` clause** whose row count is the
 *   answer. If the predicate does not really constrain, a worker that had not
 *   noticed a cancel marks the run completed.
 * - **`appendStep`'s `on conflict do nothing` is a no-op only if the primary key
 *   really is `(slug, run_id, key)`.** A recorder replays the text and cannot
 *   know whether the constraint it names exists.
 * - **TENANCY, which is the one the self-hosted store has no version of.** Every
 *   statement here carries a slug taken from the bearer, and the claim is that a
 *   guessed run id reaches nothing. That is a claim about column values in a
 *   shared table, so only a real database with two tenants' rows in it can test
 *   it — and the failure it prevents is one agent reading another's runs.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import * as journal from "./platform-workflow-journal.ts";
import type { SqlExec } from "./secret-store.ts";
import { ensurePlatformTables } from "./test-utils.ts";

/** Two tenants, so every read can be asked whether it crosses. */
const SLUG = "wfj-tenant";
const OTHER = "wfj-neighbour";

describeWithPg("the platform's workflow journal over a real Postgres", () => {
  let db: ReturnType<typeof createPostgresDb>;
  let sql: SqlExec;

  /**
   * The columns the shipped `agents` table really requires — every NOT NULL with
   * no default. Listed rather than derived, so a new required column fails HERE
   * instead of this suite silently testing a shape the migration does not have.
   */
  const seedAgent = (slug: string) =>
    sql(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
      [slug],
    );

  beforeAll(async () => {
    // `pgUrl()` inside the hook: vitest executes a skipped `describe` body to
    // enumerate it, so reading at the top would throw on a machine with no PG.
    db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (q, p) => db.query(q, p);
    await ensurePlatformTables(sql);
    await seedAgent(SLUG);
    await seedAgent(OTHER);
  });

  afterAll(async () => {
    // Both tenants' rows go with their agents — every table cascades from
    // `agents`, which is itself the property the delete test below asserts.
    await sql("delete from aai_platform.agents where slug = any($1::text[])", [[SLUG, OTHER]]);
    await db.close();
  });

  /** A fresh run id per test, so nothing shares rows. */
  let seq = 0;
  const nextRun = () => `wrun_j${++seq}`;

  async function seed(runId: string, slug = SLUG, workflow = "digest"): Promise<void> {
    await journal.createRun(sql, slug, {
      runId,
      workflow,
      status: "pending",
      createdAt: Date.now(),
      input: JSON.stringify({ topic: "otters" }),
    });
  }

  test("a run's input round-trips as JSON, not as a JSON string containing JSON", async () => {
    // The `::text::jsonb` binding. postgres.js JSON-serializes a parameter bound
    // to a jsonb position, so the codec's already-encoded text was stored as a
    // JSON *string containing* the JSON — after which `input` reads back as
    // `"{\"topic\":...}"` and a `Uint8Array` envelope never revives. Only a real
    // server finds this: a recorder holds JS values and cannot be stricter than
    // the driver.
    //
    // Compared by MEANING rather than by bytes, because `jsonb` NORMALIZES —
    // `{"topic":"otters"}` is stored and read back as `{"topic": "otters"}`. That
    // is what the column being `jsonb` buys (it parses on write, which is the
    // check this process cannot fake) and it is a real divergence from the memory
    // backend, which preserves bytes. Harmless because every consumer parses, and
    // asserted this way so the spec does not pin a serialization nobody promised.
    const runId = nextRun();
    await seed(runId);
    const run = await journal.getRun(sql, SLUG, runId);
    expect(JSON.parse(String(run?.input))).toEqual({ topic: "otters" });
    // The bug's own signature: a double-encode yields a STRING here, not an
    // object, so this is the assertion that actually discriminates.
    expect(typeof JSON.parse(String(run?.input))).toBe("object");
  });

  test("createRun REFUSES a second start on the same run id", async () => {
    // The one contract point this store used to break, and the only tier that can
    // show it: `on conflict … do nothing` needs a real unique constraint before
    // "no row came back" means "the id is taken". Memory throws and the
    // self-hosted store trips its primary key; this arm answered SUCCESS, so two
    // racing starts both believed they had won — on the platform arm, i.e. for
    // every deployed agent.
    const runId = nextRun();
    await seed(runId);
    await expect(
      journal.createRun(sql, SLUG, {
        runId,
        workflow: "other",
        status: "pending",
        createdAt: Date.now(),
        input: JSON.stringify({ topic: "badgers" }),
      }),
    ).rejects.toBeInstanceOf(journal.PlatformWorkflowRunTakenError);
    // The loser wrote NOTHING: the winner's workflow and input both stand. That
    // is the damage the silent success did — the run somebody is holding the id
    // for kept running while its `input` was quietly the other caller's.
    const run = await journal.getRun(sql, SLUG, runId);
    expect(run?.workflow).toBe("digest");
    expect(JSON.parse(String(run?.input))).toEqual({ topic: "otters" });
  });

  test("two racing starts on one id: exactly ONE wins", async () => {
    // `do nothing` does not WAIT on a concurrent inserter, so the loser is
    // refused without either transaction having committed — which is the shape
    // this really arrives in. A refusal that only fired against an already
    // COMMITTED row would leave the race itself silent.
    const runId = nextRun();
    const start = (input: unknown) =>
      journal.createRun(sql, SLUG, {
        runId,
        workflow: "digest",
        status: "pending",
        createdAt: Date.now(),
        input: JSON.stringify(input),
      });
    const settled = await Promise.allSettled([start({ n: 1 }), start({ n: 2 })]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [loser] = settled.filter((r) => r.status === "rejected");
    expect(loser?.status === "rejected" && loser.reason).toBeInstanceOf(
      journal.PlatformWorkflowRunTakenError,
    );
  });

  test("createdAt survives as a NUMBER, not a bigint string", async () => {
    // `bigint` arrives as a string from the driver. Left alone, every comparison
    // against a deadline is lexicographic and `listRuns`' ordering is right only
    // by accident.
    const runId = nextRun();
    const createdAt = Date.now();
    await journal.createRun(sql, SLUG, {
      runId,
      workflow: "digest",
      status: "pending",
      createdAt,
    });
    const run = await journal.getRun(sql, SLUG, runId);
    expect(run?.createdAt).toBe(createdAt);
    expect(typeof run?.createdAt).toBe("number");
  });

  test("two concurrent attempt claims get DIFFERENT numbers", async () => {
    // The atomicity claim, and the reason this tier exists. Read-then-increment
    // hands both callers the same number, after which a wedged step never reaches
    // its ceiling.
    const runId = nextRun();
    await seed(runId);
    const claims = await Promise.all([
      journal.claimAttempt(sql, SLUG, runId, "a#0"),
      journal.claimAttempt(sql, SLUG, runId, "a#0"),
      journal.claimAttempt(sql, SLUG, runId, "a#0"),
    ]);
    expect([...claims].sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });

  test("setStatus refuses a move the run is no longer eligible for", async () => {
    // A cancelled run must not be marked completed by a worker that had not
    // noticed. The row count is the answer, and the `where` is what makes it
    // atomic.
    const runId = nextRun();
    await seed(runId);
    expect(await journal.setStatus(sql, SLUG, runId, "cancelled", undefined, undefined)).toBe(true);
    expect(
      await journal.setStatus(sql, SLUG, runId, "completed", { output: `"done"` }, ["running"]),
    ).toBe(false);
    expect((await journal.getRun(sql, SLUG, runId))?.status).toBe("cancelled");
  });

  test("an absent expect list matches any status, which is what a cancel wants", async () => {
    const runId = nextRun();
    await seed(runId);
    expect(await journal.setStatus(sql, SLUG, runId, "running", undefined, undefined)).toBe(true);
    expect(await journal.setStatus(sql, SLUG, runId, "cancelled", undefined, undefined)).toBe(true);
  });

  test("appendStep is idempotent, and the FIRST entry stays authoritative", async () => {
    // `on conflict do nothing` is a no-op only if the primary key really is
    // `(slug, run_id, key)`. The loser of a race would otherwise insert a second
    // entry and the two replays would diverge on what the step returned.
    const runId = nextRun();
    await seed(runId);
    const first = await journal.appendStep(sql, SLUG, runId, {
      key: "fetch#0",
      name: "fetch",
      status: "ok",
      output: `"first"`,
      error: undefined,
      attempts: 1,
      startedAt: undefined,
      finishedAt: 10,
    });
    const second = await journal.appendStep(sql, SLUG, runId, {
      key: "fetch#0",
      name: "fetch",
      status: "ok",
      output: `"second"`,
      error: undefined,
      attempts: 9,
      startedAt: undefined,
      finishedAt: 99,
    });
    expect(first.output).toBe(`"first"`);
    expect(second.output).toBe(`"first"`);
    expect(second.attempts).toBe(1);
    expect(await journal.readSteps(sql, SLUG, runId)).toHaveLength(1);
  });

  test("claimSleep keeps the FIRST deadline, so a replay cannot push it out", async () => {
    // `ctx.sleep(60_000)` is re-evaluated on every delivery. Storing the newly
    // computed deadline each time pushes it 60 seconds further out per replay and
    // the run never wakes.
    const runId = nextRun();
    await seed(runId);
    const first = await journal.claimSleep(sql, SLUG, runId, "sleep!0", 1000, undefined, "sleep");
    const again = await journal.claimSleep(sql, SLUG, runId, "sleep!0", 99_000, undefined, "sleep");
    expect(first.wakeAt).toBe(1000);
    expect(again.wakeAt).toBe(1000);
  });

  test("a BARE wake reaches ordinary sleeps and NOT a hook deadline", async () => {
    // The bug this pins: journaling a hook's timeout as an ordinary sleep meant a
    // "send it now" tool calling `wakeUp()` also closed every open approval
    // window on the run.
    const runId = nextRun();
    await seed(runId);
    const far = Date.now() + 3_600_000;
    await journal.claimSleep(sql, SLUG, runId, "sleep!0", far, undefined, "sleep");
    await journal.claimSleep(sql, SLUG, runId, "hookTimeout!0", far, undefined, "hookTimeout");
    expect(await journal.wakeSleeps(sql, SLUG, runId, Date.now(), undefined)).toBe(1);
    // The approval window is still open.
    const hook = await journal.claimSleep(
      sql,
      SLUG,
      runId,
      "hookTimeout!0",
      far,
      undefined,
      "hookTimeout",
    );
    expect(hook.woken).toBe(false);
  });

  test("an ELAPSED wait is not one this call stopped", async () => {
    // The number is what this call CHANGED, which is what makes `0` an answer a
    // caller can act on rather than a tie between "nothing was waiting" and "I
    // woke something twice".
    const runId = nextRun();
    await seed(runId);
    await journal.claimSleep(sql, SLUG, runId, "sleep!0", Date.now() - 1000, undefined, "sleep");
    expect(await journal.wakeSleeps(sql, SLUG, runId, Date.now(), undefined)).toBe(0);
  });

  test("a correlated wake reaches only the ids it names", async () => {
    const runId = nextRun();
    await seed(runId);
    const far = Date.now() + 3_600_000;
    await journal.claimSleep(sql, SLUG, runId, "sleep!0", far, "order-7", "sleep");
    await journal.claimSleep(sql, SLUG, runId, "sleep!1", far, "order-8", "sleep");
    expect(await journal.wakeSleeps(sql, SLUG, runId, Date.now(), ["order-7"])).toBe(1);
  });

  test("a hook token is claimed, delivered once, and refused after", async () => {
    // A body is replayed and must read the SAME answer every time, or two walks
    // of it diverge. The `where` on `delivered = false` is what makes that atomic.
    const runId = nextRun();
    await seed(runId);
    const token = `tok-${runId}`;
    const hook = await journal.claimHook(sql, SLUG, runId, "hook!0", token);
    expect(hook.delivered).toBe(false);
    expect(await journal.deliverHook(sql, SLUG, token, `{"approved":true}`)).toBe(runId);
    // A second delivery answers nothing — the caller's retry must not overwrite.
    expect(await journal.deliverHook(sql, SLUG, token, `{"approved":false}`)).toBeUndefined();
    const after = await journal.claimHook(sql, SLUG, runId, "hook!0", token);
    expect(after.delivered).toBe(true);
    // By meaning, not bytes — `jsonb` normalizes; see the round-trip test above.
    expect(JSON.parse(String(after.payload))).toEqual({ approved: true });
  });

  test("releases the run's hook TOKENS when it goes terminal", async () => {
    // A derived token is what the SDK tells authors to use — `recap-workflow`
    // derives `retention:<sessionId>` — so a token held past its run served
    // exactly one run ever: the second recap in a session hit `claimHook`'s
    // conflict, which is not a suspend, so the saga compensated and deleted the
    // transcript it had just made. Only the memory backend released; both SQL
    // ones did not.
    const first = nextRun();
    await seed(first);
    await journal.claimHook(sql, SLUG, first, "hook!0", "retention:sess-1");
    await journal.setStatus(sql, SLUG, first, "completed", undefined, undefined);

    // The same DERIVED token, a second run, same session.
    const second = nextRun();
    await seed(second);
    await expect(
      journal.claimHook(sql, SLUG, second, "hook!0", "retention:sess-1"),
    ).resolves.toMatchObject({ token: "retention:sess-1" });
  });

  test("does NOT release while the run is still going", async () => {
    // A hook's whole point is outliving the step that opened it.
    const runId = nextRun();
    await seed(runId);
    await journal.claimHook(sql, SLUG, runId, "hook!0", `live-${runId}`);
    await journal.setStatus(sql, SLUG, runId, "running", undefined, undefined);
    const other = nextRun();
    await seed(other);
    await expect(journal.claimHook(sql, SLUG, other, "hook!0", `live-${runId}`)).rejects.toThrow(
      /already held/,
    );
  });

  test("does not release when the compare-and-set REFUSED the move", async () => {
    // The release rides the same statement as the update, so a refused move must
    // leave the tokens alone — otherwise a worker that had not noticed a cancel
    // frees a token the run is still parked on.
    const runId = nextRun();
    await seed(runId);
    await journal.claimHook(sql, SLUG, runId, "hook!0", `refused-${runId}`);
    expect(await journal.setStatus(sql, SLUG, runId, "completed", undefined, ["running"])).toBe(
      false,
    );
    const other = nextRun();
    await seed(other);
    await expect(journal.claimHook(sql, SLUG, other, "hook!0", `refused-${runId}`)).rejects.toThrow(
      /already held/,
    );
  });

  test("a CLOSED window refuses a late delivery", async () => {
    const runId = nextRun();
    await seed(runId);
    const token = `tok-${runId}`;
    await journal.claimHook(sql, SLUG, runId, "hook!0", token);
    await journal.closeHook(sql, SLUG, runId, "hook!0");
    expect(await journal.deliverHook(sql, SLUG, token, "null")).toBeUndefined();
  });

  test("a token another RUN holds is refused, naming the holder", async () => {
    // Two waits sharing a token means one signal resolves whichever row the
    // planner reached first and the other waits forever — a bug worth failing the
    // run over rather than resolving arbitrarily. The unique index is what makes
    // this a real check.
    const mine = nextRun();
    const theirs = nextRun();
    await seed(mine);
    await seed(theirs);
    const token = `tok-shared-${mine}`;
    await journal.claimHook(sql, SLUG, mine, "hook!0", token);
    await expect(journal.claimHook(sql, SLUG, theirs, "hook!0", token)).rejects.toThrow(
      new RegExp(`already held by run ${mine}`),
    );
  });

  test("listRuns is newest first, and scoped to one workflow", async () => {
    const older = nextRun();
    const newer = nextRun();
    await journal.createRun(sql, SLUG, {
      runId: older,
      workflow: "listing",
      status: "pending",
      createdAt: 1000,
    });
    await journal.createRun(sql, SLUG, {
      runId: newer,
      workflow: "listing",
      status: "pending",
      createdAt: 2000,
    });
    await journal.createRun(sql, SLUG, {
      runId: nextRun(),
      workflow: "other",
      status: "pending",
      createdAt: 3000,
    });
    const runs = await journal.listRuns(sql, SLUG, "listing", 10);
    expect(runs.map((run) => run.runId)).toEqual([newer, older]);
  });

  /**
   * TENANCY — the group the self-hosted store has no version of, and the reason a
   * shared table needs a real database to test.
   *
   * The claim is that the slug is part of every key and every statement, so a
   * guessed run id reaches nothing. Each case here is a read that WOULD cross if
   * a statement dropped its slug parameter.
   */
  test("a neighbour cannot read this tenant's run", async () => {
    const runId = nextRun();
    await seed(runId);
    expect(await journal.getRun(sql, SLUG, runId)).toBeDefined();
    expect(await journal.getRun(sql, OTHER, runId)).toBeUndefined();
  });

  test("a neighbour cannot see this tenant's steps", async () => {
    const runId = nextRun();
    await seed(runId);
    await journal.appendStep(sql, SLUG, runId, {
      key: "a#0",
      name: "a",
      status: "ok",
      output: "1",
      error: undefined,
      attempts: 1,
      startedAt: undefined,
      finishedAt: 1,
    });
    expect(await journal.readSteps(sql, SLUG, runId)).toHaveLength(1);
    expect(await journal.readSteps(sql, OTHER, runId)).toEqual([]);
    // The KEYED read is the same claim on the same table by a second statement,
    // and a neighbour who guessed the run id has usually guessed the step key
    // too — `name#occurrence` is the author's own literal plus a counter.
    expect(await journal.readStep(sql, SLUG, runId, "a#0")).toBeDefined();
    expect(await journal.readStep(sql, OTHER, runId, "a#0")).toBeNull();
  });

  test("a neighbour cannot move this tenant's status", async () => {
    const runId = nextRun();
    await seed(runId);
    expect(await journal.setStatus(sql, OTHER, runId, "cancelled", undefined, undefined)).toBe(
      false,
    );
    expect((await journal.getRun(sql, SLUG, runId))?.status).toBe("pending");
  });

  test("a neighbour cannot wake this tenant's sleeps", async () => {
    const runId = nextRun();
    await seed(runId);
    await journal.claimSleep(
      sql,
      SLUG,
      runId,
      "sleep!0",
      Date.now() + 3_600_000,
      undefined,
      "sleep",
    );
    expect(await journal.wakeSleeps(sql, OTHER, runId, Date.now(), undefined)).toBe(0);
    expect(await journal.wakeSleeps(sql, SLUG, runId, Date.now(), undefined)).toBe(1);
  });

  test("a neighbour cannot deliver to this tenant's hook, even holding the token", async () => {
    // The sharpest one: the token is the whole authorization on the webhook
    // route, so if `deliverHook` dropped its slug a leaked token would resolve
    // another agent's run.
    const runId = nextRun();
    await seed(runId);
    const token = `tok-${runId}`;
    await journal.claimHook(sql, SLUG, runId, "hook!0", token);
    expect(await journal.deliverHook(sql, OTHER, token, "null")).toBeUndefined();
    expect(await journal.deliverHook(sql, SLUG, token, "null")).toBe(runId);
  });

  test("the SAME token may be used by two different tenants", async () => {
    // The consequence of `(slug, token)` rather than a globally unique token: one
    // agent minting a token cannot collide with another's. A global index would
    // make that a cross-tenant failure with no symptom on either side.
    const mine = nextRun();
    const theirs = nextRun();
    await seed(mine);
    await seed(theirs, OTHER);
    await journal.claimHook(sql, SLUG, mine, "hook!0", "shared-token");
    await journal.claimHook(sql, OTHER, theirs, "hook!0", "shared-token");
    expect(await journal.deliverHook(sql, SLUG, "shared-token", "null")).toBe(mine);
    expect(await journal.deliverHook(sql, OTHER, "shared-token", "null")).toBe(theirs);
  });

  test("deleting an agent takes its journal with it", async () => {
    // Every table cascades from `agents`. Without that, a deleted agent leaves
    // rows no slug can reach and nothing sweeps them.
    const gone = "wfj-gone";
    await seedAgent(gone);
    const runId = nextRun();
    await seed(runId, gone);
    await journal.appendStep(sql, gone, runId, {
      key: "a#0",
      name: "a",
      status: "ok",
      output: "1",
      error: undefined,
      attempts: 1,
      startedAt: undefined,
      finishedAt: 1,
    });
    await sql("delete from aai_platform.agents where slug = $1", [gone]);
    expect(await journal.getRun(sql, gone, runId)).toBeUndefined();
    expect(await sql("select 1 from aai_platform.workflow_steps where slug = $1", [gone])).toEqual(
      [],
    );
  });
});
