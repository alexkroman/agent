// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow queue against a REAL Postgres, because every claim it makes is a
 * claim about SQL.
 *
 * `distinct on`, `for update skip locked`, a partial index and an interval
 * arithmetic due time cannot be checked by a fake: a recorder would assert the
 * statement text we wrote, which is the thing under test. What matters here —
 * that two concurrent sweeps take disjoint sets, that one run yields one message,
 * that a stale claim comes back — is only observable against a server.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { createPlatformQueueSend } from "@alexkroman1/aai-runtime/internal";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import type { HonoEnv } from "./context.ts";
import { guestTokenFor } from "./guest-token.ts";
import { slugMw } from "./middleware.ts";
import type { AdminDb } from "./platform-lock.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import type { SqlExec } from "./secret-store.ts";
import { createTestStore, ensurePlatformTables, type TestFetch } from "./test-utils.ts";
import { createWorkflowEnqueueHandler } from "./workflow-enqueue-handler.ts";
import {
  ack,
  claimDue,
  enqueue,
  envelopeBody,
  fail,
  parseEnvelope,
  QUEUE_MAX_ATTEMPTS,
  WORKFLOW_QUEUE_CHANNEL,
} from "./workflow-queue-store.ts";
import { runQueuePass } from "./workflow-queue-sweep.ts";

describeWithPg("workflow queue store", () => {
  let close: () => Promise<void>;
  let sql: SqlExec;
  /** The same database as `sql`, as the reserving handle a pass needs. */
  let adminDb: () => AdminDb;
  /**
   * A real platform over that same database, so the loop test can go through the
   * HTTP route rather than calling `enqueue` directly. The agents live in
   * Postgres; only the BUNDLE store is in memory, which this suite never reads.
   */
  let platformFetch: TestFetch;

  /** Every tenant this suite creates, so `afterAll` can remove exactly those. */
  const SLUGS = ["wfq-t1", "wfq-t2", "wfq-gone"];

  /**
   * The columns the shipped `agents` table really requires — every NOT NULL
   * without a default. Listed rather than derived, so a new required column
   * fails HERE, loudly, instead of this suite silently testing a table shape the
   * migration does not have.
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
    const db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (q, p) => db.query(q, p);
    adminDb = () => ({ reserve: () => db.reserve(), listen: (c, f) => db.listen(c, f) });
    close = () => db.close();

    // The SCHEMA comes from the repo's own helper, never from this file.
    // `ensurePlatformTables` verifies a CLI-built stack against its ledger and
    // otherwise applies the migrations to a database that lacks them — which is
    // what makes this suite run on BOTH arms: a plain Postgres (CI's
    // `AAI_TEST_PG_URL` is the runner's own cluster) and the local Supabase
    // stack. An earlier draft asserted the table was already there, which passed
    // locally against a migrated stack and failed every CI run.
    //
    // It also replaced a `create table if not exists` of this suite's own, which
    // was worse than useless: it invented a shape the migration might not have,
    // and a matching `drop` in `afterAll` destroyed the real table for every
    // later suite (`realtime-rls.scenario.test.ts` reported it missing). A
    // scenario test may own its ROWS; it may not own the schema.
    await ensurePlatformTables(sql);
    for (const slug of SLUGS) await seedAgent(slug);

    // JUST the enqueue route over that same database — deliberately NOT
    // `createTestOrchestrator`.
    //
    // A full orchestrator starts this surface's background sweeps and keeps no
    // handle to stop them (`agent-sweeps.ts`), so with a real `adminDb` this suite
    // left a 1-SECOND queue sweep running against the shared scenario database
    // after it finished. That is exactly what it did on the first run: every test
    // here passed and `workflow-world.scenario.test.ts` failed beside it, which is
    // the most expensive shape of test failure available — a suite breaking a
    // sibling.
    //
    // The route needs a store for its `getAgentVersion` check and a slug from the
    // path, and nothing else, so that is all this mounts.
    const store = createTestStore();
    await store.putAgent({
      slug: SLUGS[0] as string,
      env: {},
      worker:
        'export default { name: "a", systemPrompt: "p", greeting: "", maxSteps: 1, tools: {} };',
      clientFiles: {},
      credential_hashes: [],
    });
    const app = new Hono<HonoEnv>();
    app.use("*", async (c, next) => {
      c.env = { store } as HonoEnv["Bindings"];
      await next();
    });
    app.post("/:slug/workflow-enqueue", slugMw, createWorkflowEnqueueHandler(adminDb()));
    // `app.request` is sync-or-async depending on the route; `TestFetch` is the
    // async half, which is what every caller here awaits anyway.
    platformFetch = async (input, init) => app.request(input, init);
  });

  afterAll(async () => {
    // Only what this suite created. Deleting the agents cascades to their
    // messages, which is the FK doing the cleanup rather than a second delete
    // that could drift from it.
    for (const slug of SLUGS) {
      await sql("delete from aai_platform.agents where slug = $1", [slug]).catch(() => undefined);
    }
    await close?.();
  });

  beforeEach(async () => {
    await sql("delete from aai_platform.workflow_queue where slug = any($1::text[])", [SLUGS]);
  });

  const msg = (id: string, runId: string, over: Record<string, unknown> = {}) => ({
    id,
    slug: SLUGS[0] as string,
    queueName: `__wkf_workflow_${runId}`,
    payload: { runId },
    ...over,
  });

  test("an enqueued message is claimable, and claiming removes it from the due set", async () => {
    await enqueue(sql, msg("m1", "r1"));
    const first = await claimDue(sql, 10);
    expect(first.map((m) => m.id)).toEqual(["m1"]);
    expect(first[0]?.queueName).toBe("__wkf_workflow_r1");
    expect(first[0]?.payload).toEqual({ runId: "r1" });
    // The partial index excludes a claimed row, so a second sweep sees nothing.
    expect(await claimDue(sql, 10)).toEqual([]);
  });

  /**
   * `delaySeconds` IS `sleep`, so a future message must be invisible until due —
   * and nothing is held in the meantime, which is the whole point of the design.
   */
  test("a delayed message is not due yet", async () => {
    await enqueue(sql, { ...msg("m1", "r1"), delaySeconds: 3600 });
    expect(await claimDue(sql, 10)).toEqual([]);
    // Bring it forward rather than waiting an hour: the assertion is about the
    // due-time comparison, not about the clock.
    await sql("update aai_platform.workflow_queue set available_at = now() - interval '1 second'");
    expect((await claimDue(sql, 10)).map((m) => m.id)).toEqual(["m1"]);
  });

  /**
   * ONE PER RUN. A run's journal is replayed on every delivery, so two messages
   * for one run in flight together interleave two replays of the same log — which
   * a stand-in without this rule turned into a bounded fan-out returning `failed`
   * instead of `completed`.
   */
  test("one run yields one message, while other runs go in parallel", async () => {
    await enqueue(sql, msg("a1", "r1"));
    await enqueue(sql, msg("a2", "r1"));
    await enqueue(sql, msg("b1", "r2"));
    const claimed = await claimDue(sql, 10);
    expect(claimed).toHaveLength(2);
    // One from each run, never two from one.
    expect(new Set(claimed.map((m) => (m.payload as { runId: string }).runId))).toEqual(
      new Set(["r1", "r2"]),
    );
    // The held-back sibling is still there, and comes on the next pass once the
    // first is acked.
    await ack(sql, claimed.find((m) => m.queueName.endsWith("r1"))?.id ?? "");
    const next = await claimDue(sql, 10);
    expect(next.map((m) => (m.payload as { runId: string }).runId)).toContain("r1");
  });

  /**
   * The half of one-per-run that is easy to miss: a run whose earlier message is
   * still IN FLIGHT must not hand out a second one. Without the `not exists`
   * guard the sibling becomes claimable the moment the first is claimed, which is
   * two concurrent replays of one journal.
   */
  test("a run with an in-flight message yields nothing until it settles", async () => {
    await enqueue(sql, msg("a1", "r1"));
    await enqueue(sql, msg("a2", "r1"));
    const first = await claimDue(sql, 10);
    expect(first).toHaveLength(1);
    // Still claimed, not acked — the sibling stays invisible.
    expect(await claimDue(sql, 10)).toEqual([]);
    await ack(sql, first[0]?.id ?? "");
    expect((await claimDue(sql, 10)).map((m) => m.id)).toEqual(["a2"]);
  });

  test("the claim honours its limit", async () => {
    for (let i = 0; i < 5; i++) await enqueue(sql, msg(`m${i}`, `r${i}`));
    expect(await claimDue(sql, 2)).toHaveLength(2);
  });

  /**
   * OLDEST-DUE wins, across tenants.
   *
   * `distinct on` obliges an `order by` starting with its own expressions, so the
   * single-CTE version of this query truncated to the limit in `(slug, runId)`
   * order — lexicographically by TENANT. `wfq-t1` sorts before `wfq-t2`, so a
   * `wfq-t1` with more due runs than one tick's width filled the candidate set
   * every tick; claimed rows are excluded by the `not exists`, so the next tick
   * took its NEXT batch and `wfq-t2` waited forever on that replica.
   *
   * The case is written with the STARVED tenant's message also being the oldest,
   * which is what makes the assertion about fairness rather than about slug
   * order: it is the message that has waited longest, and it loses on a name.
   */
  test("a busy early-sorting tenant cannot starve a later one", async () => {
    await enqueue(sql, msg("older", "r-older", { slug: SLUGS[1] }));
    // Backdate it rather than sleeping: the claim compares `available_at`, and
    // every message enqueued in this test is otherwise due within one tick of
    // the others.
    await sql(
      "update aai_platform.workflow_queue set available_at = now() - interval '1 hour' where id = $1",
      ["older"],
    );
    // Five distinct RUNS on the early-sorting tenant, so `distinct on` yields
    // five candidates from it alone — more than the width below.
    for (let i = 0; i < 5; i++) await enqueue(sql, msg(`busy${i}`, `r${i}`));

    const claimed = await claimDue(sql, 3);
    expect(claimed).toHaveLength(3);
    // The oldest message wins the tick whoever owns it. Ordered by slug, this
    // was three `wfq-t1` messages and `older` was not among them.
    expect(claimed.map((m) => m.id)).toContain("older");
    expect(claimed[0]?.id).toBe("older");
  });

  /**
   * The same starvation one level up: a tenant under CONTINUOUS load. One tick
   * proves the ordering; this proves the later tenant is actually served while
   * the earlier one keeps producing.
   */
  test("a continuously busy tenant does not keep a later one unclaimed", async () => {
    await enqueue(sql, msg("waiting", "r-waiting", { slug: SLUGS[1] }));
    let produced = 0;
    const claimedIds: string[] = [];
    for (let tick = 0; tick < 3; tick++) {
      // The busy tenant refills faster than a tick can drain it.
      for (let i = 0; i < 4; i++) await enqueue(sql, msg(`busy${produced++}`, `r${produced}`));
      const claimed = await claimDue(sql, 2);
      claimedIds.push(...claimed.map((m) => m.id));
      // Settle them, or the `not exists` holds their runs and the next tick
      // reads a different situation than a real sweep would.
      for (const m of claimed) await ack(sql, m.id);
    }
    expect(claimedIds).toContain("waiting");
  });

  /**
   * Two replicas sweep at once. `for update skip locked` is what makes them take
   * DISJOINT sets — without it the second waits out the first's transaction and
   * the sweep rate halves on the one mechanism that resumes a parked run.
   */
  test("concurrent sweeps take disjoint sets, and never the same message", async () => {
    // EIGHT overlapping sweeps, each asking for everything, over one batch — a
    // pair of sequential calls does not overlap in practice and passed with the
    // re-check removed, i.e. tested nothing. Repeated, because a race that is
    // only sometimes provoked is only sometimes a test.
    for (let round = 0; round < 8; round++) {
      await sql("delete from aai_platform.workflow_queue");
      for (let i = 0; i < 24; i++) await enqueue(sql, msg(`r${round}m${i}`, `r${round}run${i}`));
      const sweeps = await Promise.all(Array.from({ length: 8 }, () => claimDue(sql, 24)));
      const ids = sweeps.flat().map((m) => m.id);
      // The property: a message is claimed by AT MOST ONE sweep. Two sweeps
      // returning the same id would mean it is delivered twice.
      expect(new Set(ids).size, `round ${round} handed one message to two sweeps`).toBe(ids.length);
      expect(ids.length).toBeGreaterThan(0);
    }
  });

  /**
   * A replica that dies mid-delivery leaves `locked_at` set, and the due index
   * excludes claimed rows — so without a staleness rule nothing would ever look
   * at those messages again.
   */
  test("a stale claim is reclaimable; a fresh one is not", async () => {
    await enqueue(sql, msg("m1", "r1"));
    await claimDue(sql, 10);
    expect(await claimDue(sql, 10, 60_000)).toEqual([]);
    await sql("update aai_platform.workflow_queue set locked_at = now() - interval '10 minutes'");
    expect((await claimDue(sql, 10, 60_000)).map((m) => m.id)).toEqual(["m1"]);
  });

  test("an idempotency key collapses a duplicate and reports the surviving id", async () => {
    const a = await enqueue(sql, { ...msg("first", "r1"), idempotencyKey: "k" });
    const b = await enqueue(sql, { ...msg("second", "r1"), idempotencyKey: "k" });
    expect(a.id).toBe("first");
    // The SURVIVOR's id, not the one offered — a caller needs the message that
    // really exists.
    expect(b.id).toBe("first");
    const rows = await sql("select count(*)::int as n from aai_platform.workflow_queue");
    expect(rows[0]?.n).toBe(1);
  });

  test("the same key on a DIFFERENT tenant is a different message", async () => {
    await enqueue(sql, { ...msg("m1", "r1"), idempotencyKey: "k" });
    await enqueue(sql, { ...msg("m2", "r1"), slug: SLUGS[1] as string, idempotencyKey: "k" });
    const rows = await sql("select count(*)::int as n from aai_platform.workflow_queue");
    expect(rows[0]?.n).toBe(2);
  });

  test("a failed delivery backs off, then is abandoned at the budget", async () => {
    await enqueue(sql, msg("m1", "r1"));
    const [claimed] = await claimDue(sql, 1);
    expect(await fail(sql, claimed?.id ?? "", claimed?.attempt ?? 0)).toBe("retry");
    // Backed off, so not immediately due again — and unclaimed, so a later sweep
    // can take it.
    expect(await claimDue(sql, 10)).toEqual([]);
    const rows = await sql("select attempt, locked_at from aai_platform.workflow_queue");
    expect(rows[0]?.attempt).toBe(1);
    expect(rows[0]?.locked_at).toBeNull();

    expect(await fail(sql, "m1", QUEUE_MAX_ATTEMPTS - 1)).toBe("dropped");
    const after = await sql("select count(*)::int as n from aai_platform.workflow_queue");
    expect(after[0]?.n).toBe(0);
  });

  /**
   * The SWEEP over the real store, end to end: claim, deliver, settle.
   *
   * `workflow-queue-sweep.test.ts` drives the same pass with the store faked, so
   * what this adds is that the two halves agree — the claim really hands back
   * what the sweep expects, and its ack and its backoff really land on the rows.
   * A pass is driven directly rather than through an interval; the interval is
   * `createIntervalSweep`'s and has its own spec.
   */
  test("a pass delivers what it claims and removes it", async () => {
    await enqueue(sql, msg("m1", "r1"));
    await enqueue(sql, msg("m2", "r2"));
    const seen: string[] = [];
    const pass = await runQueuePass({
      adminDb: adminDb(),
      deliver: async (m) => {
        seen.push(m.id);
        return { type: "completed" };
      },
    });
    expect(pass).toEqual({ claimed: 2, delivered: 2, rescheduled: 0, retried: 0, dropped: 0 });
    expect(seen.sort((a, b) => a.localeCompare(b))).toEqual(["m1", "m2"]);
    const rows = await sql("select count(*)::int as n from aai_platform.workflow_queue");
    expect(rows[0]?.n).toBe(0);
  });

  test("a pass that cannot deliver leaves the message due again later", async () => {
    await enqueue(sql, msg("m1", "r1"));
    const pass = await runQueuePass({
      adminDb: adminDb(),
      deliver: async () => {
        throw new Error("guest unreachable");
      },
    });
    expect(pass.retried).toBe(1);
    // Still there, unclaimed, attempt raised, and NOT due yet — so the next tick
    // does not immediately retry a guest that just refused.
    const rows = await sql(
      "select attempt, locked_at, available_at > now() as later from aai_platform.workflow_queue",
    );
    expect(rows[0]?.attempt).toBe(1);
    expect(rows[0]?.locked_at).toBeNull();
    expect(rows[0]?.later).toBe(true);
  });

  /**
   * The third outcome over the REAL store: a run that parked itself.
   *
   * The faked-store spec asserts the sweep calls `reschedule`; this asserts what
   * that does to the row — still there, unclaimed, due LATER, and with its
   * attempt untouched. The attempt is the half a fake cannot really check, and
   * it is the one that decides whether a workflow may sleep more than
   * `QUEUE_MAX_ATTEMPTS` times.
   */
  test("a sleeping run comes back later without spending an attempt", async () => {
    await enqueue(sql, msg("m1", "r1"));
    const pass = await runQueuePass({
      adminDb: adminDb(),
      deliver: async () => ({ type: "reschedule", delaySeconds: 120 }),
    });
    expect(pass.rescheduled).toBe(1);
    const rows = await sql(
      `select attempt, locked_at, available_at > now() + interval '60 seconds' as much_later
         from aai_platform.workflow_queue`,
    );
    expect(rows[0]?.attempt).toBe(0);
    expect(rows[0]?.locked_at).toBeNull();
    expect(rows[0]?.much_later).toBe(true);
  });

  test("a negative sleep is clamped rather than made due in the past", async () => {
    // The number comes from tenant code by way of the DevKit, so it is not
    // trusted to be sane: a negative interval would make the message due BEFORE
    // it was written, which reads as an immediately-redelivered run.
    await enqueue(sql, msg("m1", "r1"));
    await runQueuePass({
      adminDb: adminDb(),
      deliver: async () => ({ type: "reschedule", delaySeconds: -3600 }),
    });
    const rows = await sql(
      "select available_at <= now() as due, available_at > now() - interval '5 seconds' as recent from aai_platform.workflow_queue",
    );
    expect(rows[0]?.due).toBe(true);
    expect(rows[0]?.recent).toBe(true);
  });

  /**
   * THE WHOLE LOOP, over a real database: the guest's own enqueue client, the
   * platform's HTTP route, the real store, the claim, and the delivery.
   *
   * Every other spec in this series covers one hop with the next one faked. This is
   * the only place the four agree — and the two that most need checking against
   * each other are the ENVELOPE and the RUN ID, because the guest writes them and
   * the claim's `distinct on (slug, payload->>'runId')` reads them out of jsonb.
   * That is exactly where a double-encoded payload silently collapsed this queue's
   * per-run ordering once already, and a fake cannot see it: a fake holds JS
   * values.
   */
  test("a message the guest enqueues is claimed and delivered, envelope intact", async () => {
    const bearer = guestTokenFor(agentSandboxName(SLUGS[0] as string, 1));
    // The guest's real client, pointed at the platform's real route through the
    // orchestrator's own fetch. `AAI_GUEST_TOKEN_SECRET` is unset here, so
    // `guestTokenFor` draws a per-process key — which both sides read, so they
    // agree.
    const send = createPlatformQueueSend({
      base: `http://platform.test/${SLUGS[0]}`,
      token: bearer,
      fetch: async (input, init) => {
        const req = new Request(input, init);
        return platformFetch(new URL(req.url).pathname, {
          method: req.method,
          headers: req.headers,
          body: await req.text(),
        });
      },
    });

    const input = new Uint8Array([7, 0, 255]);
    const sent = await send("__wkf_workflow_r-loop", { runId: "r-loop", runInput: { input } });
    expect(sent.messageId).toMatch(/^wfq_/);

    // Claimed and delivered by the real sweep.
    const delivered: { queueName: string; body: Buffer }[] = [];
    const pass = await runQueuePass({
      adminDb: adminDb(),
      deliver: async (m) => {
        delivered.push({ queueName: m.queueName, body: envelopeBody(parseEnvelope(m.payload)) });
        return { type: "completed" };
      },
    });
    expect(pass).toEqual({ claimed: 1, delivered: 1, rescheduled: 0, retried: 0, dropped: 0 });
    expect(delivered[0]?.queueName).toBe("__wkf_workflow_r-loop");

    // The bytes survived jsonb, base64, an HTTP hop and a claim — and the
    // `Uint8Array` came back as one rather than as an index map.
    const revived = JSON.parse(delivered[0]?.body.toString() ?? "{}", (_k, v: unknown) =>
      isRecord(v) && v.__type === "Uint8Array" && typeof v.data === "string"
        ? new Uint8Array(Buffer.from(v.data, "base64"))
        : v,
    ) as { runId: string; runInput: { input: Uint8Array } };
    expect(revived.runId).toBe("r-loop");
    expect(revived.runInput.input).toEqual(input);

    // And it is gone, because the delivery was acked.
    const rows = await sql("select count(*)::int as n from aai_platform.workflow_queue");
    expect(rows[0]?.n).toBe(0);
  });

  /**
   * The per-run ordering the envelope exists to make possible, end to end.
   *
   * Three messages for one run, enqueued through the real route, must yield ONE
   * claim — and a double-encoded payload makes `payload->>'runId'` null for every
   * row, which collapses `distinct on` and hands back all three.
   */
  test("three messages for one run are claimed one at a time", async () => {
    const bearer = guestTokenFor(agentSandboxName(SLUGS[0] as string, 1));
    const send = createPlatformQueueSend({
      base: `http://platform.test/${SLUGS[0]}`,
      token: bearer,
      fetch: async (input, init) => {
        const req = new Request(input, init);
        return platformFetch(new URL(req.url).pathname, {
          method: req.method,
          headers: req.headers,
          body: await req.text(),
        });
      },
    });
    for (const n of [1, 2, 3]) {
      await send("__wkf_step_r-one", { workflowRunId: "r-one", stepId: `s${n}` });
    }
    const claimed = await claimDue((q, p) => sql(q, p), 10);
    expect(claimed).toHaveLength(1);
  });

  test("acking removes the message", async () => {
    await enqueue(sql, msg("m1", "r1"));
    await ack(sql, "m1");
    const rows = await sql("select count(*)::int as n from aai_platform.workflow_queue");
    expect(rows[0]?.n).toBe(0);
  });

  /**
   * The NOTIFY half, against a real Postgres — the only place it can be tested.
   *
   * `enqueue` announces so a listening replica delivers without waiting out the
   * poll interval, which is the latency floor of every step-to-step hop. Whether a
   * notification actually crosses the wire is a property of Postgres and
   * postgres.js's `listen`, so a fake proves nothing here.
   */
  test("enqueuing a DUE message notifies a listener", async () => {
    const fired: number[] = [];
    const listener = createPostgresDb({ url: pgUrl(), max: 1 });
    try {
      const unlisten = await listener.listen(WORKFLOW_QUEUE_CHANNEL, () => {
        fired.push(1);
      });
      try {
        await enqueue(sql, msg("m1", "r1"));
        // The notification is delivered on COMMIT and travels asynchronously, so
        // this polls rather than assuming it has landed by the time `enqueue`
        // resolves.
        await vi.waitFor(() => expect(fired.length).toBeGreaterThan(0));
      } finally {
        unlisten();
      }
    } finally {
      await listener.close();
    }
  });

  /**
   * A DELAYED message does NOT notify, and the absence is the assertion.
   *
   * A notification says "look now" and there is nothing to find until
   * `available_at` passes — so announcing a `sleep()` would wake every replica to
   * run a query that returns nothing. A parked message is what the periodic pass
   * exists for, and it is the one thing a notification cannot express.
   *
   * ## Why the BARRIER, and not a `waitFor` on a count
   *
   * The obvious version — enqueue the delayed one, enqueue a due one as a positive
   * control, then `vi.waitFor(() => expect(count).toBe(1))` — PASSES when the code
   * is wrong, verified by making the notify unconditional. `waitFor` polls until
   * the assertion holds, and with both messages notifying it holds transiently
   * after the first arrives and before the second does.
   *
   * So the absence needs a fence rather than a timeout. Postgres delivers
   * notifications to one connection in COMMIT order, so a sentinel committed after
   * the delayed enqueue arrives after anything that enqueue would have sent: once
   * the barrier fires, "no queue notification yet" is a settled fact rather than a
   * race. A `sleep()` would be the alternative and would be both slower and
   * weaker.
   */
  test("enqueuing a DELAYED message does not notify", async () => {
    const BARRIER = "aai_test_queue_barrier";
    let queueNotifications = 0;
    let barrierFired = false;
    const listener = createPostgresDb({ url: pgUrl(), max: 2 });
    try {
      const stopQueue = await listener.listen(WORKFLOW_QUEUE_CHANNEL, () => {
        queueNotifications += 1;
      });
      const stopBarrier = await listener.listen(BARRIER, () => {
        barrierFired = true;
      });
      try {
        await enqueue(sql, { ...msg("m1", "r1"), delaySeconds: 30 });
        // Same connection as the enqueue, so ordering is guaranteed against it.
        await sql("select pg_notify($1, '')", [BARRIER]);
        await vi.waitFor(() => expect(barrierFired).toBe(true));
        expect(queueNotifications).toBe(0);

        // POSITIVE CONTROL, after the fact: without it this spec would pass on a
        // listener that never works at all, which is the vacuous-absence shape.
        await enqueue(sql, msg("m2", "r1"));
        await vi.waitFor(() => expect(queueNotifications).toBe(1));
      } finally {
        stopQueue();
        stopBarrier();
      }
    } finally {
      await listener.close();
    }
  });

  test("deleting the agent takes its queued messages with it", async () => {
    // The FK's `on delete cascade`: a message addressed to a guest that will
    // never exist again must not outlive the agent.

    await enqueue(sql, { ...msg("m1", "r1"), slug: SLUGS[2] as string });
    await sql("delete from aai_platform.agents where slug = $1", [SLUGS[2]]);
    const rows = await sql("select count(*)::int as n from aai_platform.workflow_queue");
    expect(rows[0]?.n).toBe(0);
  });
});
