// Copyright 2026 the AAI authors. MIT license.
/**
 * The POSTGRES workflow world, executed against a real database.
 *
 * This is the world production runs, and until this file existed nothing ran it
 * at all. `aai/host/workflow-world.test.ts` asserts on ENVIRONMENT VARIABLES —
 * a sound choice there, because `getWorld()` memoizes on first read and a unit
 * suite cannot un-resolve a world — and `aai-cli/dev-workflow.scenario.test.ts`,
 * the one end-to-end workflow test, writes a fixture `.env` with no
 * `DATABASE_URL`, so every durability claim it makes is proved on the LOCAL
 * world, whose own doc says a restart forgets in-flight runs.
 *
 * `aai/host/workflow-world.ts` names three hazards in prose that had no test
 * between them. What each case here does about them:
 *
 * 1. **The migration stand-in.** `@workflow/world-postgres/cli`'s
 *    `setupDatabase` is a CLI entry point: `process.exit(0)` on success,
 *    `process.exit(1)` on failure. `migratePostgresWorld` installs a
 *    `process.exit` stand-in that turns the exit into a throw. Without it
 *    `aai dev` printed `Database schema created successfully!` and exited 0
 *    before anything listened, and a deployed guest did the same before
 *    `server.listen`, so the platform's readiness poll never got an answer and
 *    every spawn failed. That the stand-in INTERCEPTS the exit is proved here —
 *    this process survives `setupDatabase` and goes on to run six more cases —
 *    and that the SUCCESS code is then read as success is proved by "a
 *    SUCCESSFUL migration is not reported as a failure". That case was written
 *    INVERTED, pinning a live defect: `setupDatabase` puts its `process.exit(0)`
 *    inside its own `try`, so the stand-in's throw landed in its `catch`, which
 *    exited 1 — every successful migration reported as `exit 1`. Fixed by having
 *    the stand-in keep the FIRST exit code.
 * 2. **The queue subscription.** `getWorld().start?.()` is what makes
 *    graphile-worker poll; without it "a run sits `pending` forever with no
 *    error anywhere". Both halves of that mechanism are exercised — a
 *    subscribed runner really dials the flow route ("enqueueing a run
 *    subscribes the queue…"), and `start()` really re-enqueues an active run
 *    ("a second process reads the run back…"). The BOOT-time call was
 *    unreachable while defect 1 stood, because the migration threw first; with
 *    that fixed, `startWorkflowWorldIfDeclared` reaches it in this suite's own
 *    `beforeAll`, which is what the absence of a "failed to start" line above
 *    now asserts.
 * 3. **A silent fallback to the local world.** The module doc names this as the
 *    hazard the configure-before-import ordering exists for — "a guest that
 *    silently uses the local world in production, writing runs to a
 *    `.workflow-data/` directory inside a container that is about to be
 *    destroyed" — and there was no positive assertion anywhere that a run
 *    landed in Postgres. Closed by "a run started through the SDK's own adapter
 *    is written to Postgres", which reads the row back with SQL and checks that
 *    no `.workflow-data/` appeared. It is the same assertion `vercel/eve`'s
 *    `e2e-postgres.yml` makes after its evals, for the same reason.
 *
 * ## What this file does NOT prove, and where that work belongs
 *
 * A run does not RESUME AND COMPLETE here, and no process is hard-killed.
 * Executing a workflow body needs the two WDK-transformed bundles, and the only
 * transform in this repo lives in `aai-cli/workflow-bundler.ts` — which this
 * package may not import (see "Dependency flow" in `AGENTS.md`). The same
 * boundary rules out `aai-cli/_fault-mode.ts`, the repo's SIGKILL supervisor,
 * which is both `_`-internal and in the package this one may not reach. So the
 * hard-kill redelivery case — a run parked mid-step when its process dies, and
 * resumed by its replacement — belongs beside the fixture that can park one:
 * `aai-cli/dev-workflow.scenario.test.ts`, booted through
 * `startSupervisedDevServer` with a `DATABASE_URL` in its fixture `.env`. That
 * is the audit's own Part IV item 5, and it is what makes the world an AXIS
 * rather than a thing one test happens to select.
 *
 * The second process below is deliberately the GRACEFUL half of that: its
 * predecessor closes its world, releasing every queue lock, which
 * `_fault-mode.ts`'s doc is explicit is the path that already works. It is here
 * because it is the only thing in the repo that shows a run record and its
 * re-enqueue crossing a process boundary at all, and it never claims more.
 *
 * ## Self-cleaning, and why it needs its own DATABASE
 *
 * The world's migration creates three schemas with FIXED names — `workflow`,
 * `workflow_drizzle` and `graphile_worker` — none of which can be namespaced.
 * `workflow-wake.scenario.test.ts` stands up a `graphile_worker.jobs` table of
 * its own in the default database, so sharing one would have the two suites
 * writing over each other. This file therefore creates and drops a database of
 * its own; `drop … with (force)` makes a re-run idempotent and also evicts the
 * lock sweep's presence connection, which is deliberately never closed.
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:5432/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sleep } from "@alexkroman1/aai/internal";
import {
  type CloseableDb,
  configureWorkflowWorld,
  createPostgresDb,
  startWorkflowWorldIfDeclared,
  wdkAdapter,
} from "@alexkroman1/aai/runtime";
import { isRecord } from "@alexkroman1/aai/utils";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";

/** The database this file owns outright. See the header. */
const DB_NAME = "aai_workflow_world_scenario";

/** The DevKit's own flow route — where the queue POSTs a run's next slice. */
const FLOW_ROUTE = "/.well-known/workflow/v1/flow";

/**
 * A workflow id shaped like the compiler's.
 *
 * WDK's `workflowName` IS the compiler's identifier (`workflow//<module>//<fn>`)
 * and `start({ workflowId })` writes whatever it is handed straight into the run
 * record, so this exercises the same column a compiled body would. Nothing
 * resolves it to code — that is the transform's job, and this package cannot
 * reach the transform.
 */
const WORKFLOW_ID = "workflow//./workflows/durability//durabilityFlow";

/**
 * Resolve a `workflow`/`@workflow/*` module the way the SDK's own code does.
 *
 * Those packages are dependencies of `@alexkroman1/aai`, not of this one, so a
 * bare specifier here does not resolve. Anchoring a require inside that package
 * yields the SAME file `aai/host/workflow-world.ts`'s own
 * `import("workflow/runtime")` reaches, which is what keeps `getWorld()`'s memo
 * shared rather than handing this file a second world. A filesystem path, not
 * an import — no module graph crosses the package boundary.
 */
const fromSdk = createRequire(new URL("../aai/index.js", import.meta.url));

/**
 * Where `@workflow/world-postgres` really lives on disk.
 *
 * `@workflow/core/runtime` resolves `WORKFLOW_TARGET_WORLD` with
 * `createRequire(join(process.cwd(), "index.js"))` — from the CWD, which under
 * vitest is THIS package, where `workflow`'s own dependencies are not visible.
 * An absolute path is the spelling `classifySuppliedWorld` exists for, and the
 * one `workflow-world.ts`'s doc records an outage over: pinned that way in a
 * pnpm workspace it used to be classified `local`, so the world loaded and was
 * never migrated.
 */
const WORLD_MODULE = fromSdk.resolve("@workflow/world-postgres");

/** The DevKit runtime entry the SDK subscribes through — same instance. */
const WORLD_RUNTIME = fromSdk.resolve("workflow/runtime");

/**
 * The second process, as source.
 *
 * Deliberately plain JavaScript with no repo import of any kind: it must not be
 * able to share a module registry, a connection pool, or a memoized world with
 * the process that started the run, because that sharing is the thing the case
 * exists to rule out. It is handed the world's resolved path rather than
 * resolving one, since `@workflow/world-postgres` is not visible from a
 * temporary directory.
 */
const SECOND_PROCESS = `
import { pathToFileURL } from "node:url";

const [, , worldModule, connectionString, runId] = process.argv;
const { createWorld } = await import(pathToFileURL(worldModule).href);
const world = createWorld({ connectionString });
const run = await world.runs.get(runId, { resolveData: "none" });
process.stdout.write(JSON.stringify({ runId: run.runId, workflowName: run.workflowName }) + "\\n");
// Re-enqueues every ACTIVE run, which is how a replacement guest picks up work
// its predecessor left behind. The parent kills this process once the dispatch
// that produces has landed on its executor.
await world.start();
await new Promise(() => {});
`;

/** One recorded call on the executor standing in for the guest's own routes. */
type ExecutorCall = { path: string; body: string };

/**
 * Everything the LOCAL world has written under this CWD, as one string.
 *
 * Empty when it has written nothing — the ordinary case, and the one that must
 * not be told apart from "the directory is missing". That directory is
 * gitignored and other suites in this package really do leave one (measured: a
 * full `test:scenario` run creates `.workflow-data/version.txt` here, this file
 * creates none), so its mere existence says nothing about which world a run
 * went to. Its CONTENTS do.
 */
async function localWorldEntries(): Promise<string> {
  const entries = await fs
    .readdir(path.join(process.cwd(), ".workflow-data"), { recursive: true })
    .catch(() => []);
  return entries.join("\n");
}

describeWithPg("the Postgres workflow world, against a real database", () => {
  /** A connection to the DEFAULT database — the only one that can create ours. */
  let admin: CloseableDb;
  /** A connection to the database the world was migrated into. */
  let db: CloseableDb;
  let worldUrl = "";
  let executorOrigin = "";
  let executor: Server;
  let executorCalls: ExecutorCall[] = [];

  /** Everything `startWorkflowWorldIfDeclared` wrote while it ran. */
  const logged: string[] = [];
  const reported: string[] = [];

  /** The run started in `beforeAll`, asserted on by several cases below. */
  let runId = "";
  /** What `configureWorkflowWorld` answered, from a database and from a path. */
  let derivedKind = "";
  let suppliedKind = "";
  /** Guards the double close between the second-process case and `afterAll`. */
  let worldClosed = false;

  /**
   * The guest's own flow/step routes, reduced to a recorder.
   *
   * A 200 with no `timeoutSeconds` is what the queue reads as "this slice
   * completed", so a dispatch neither retries nor wedges the worker. It answers
   * every path because the DevKit probes the same route for health.
   */
  async function startExecutor(): Promise<string> {
    executor = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        executorCalls.push({
          path: req.url ?? "",
          // `latin1` because the queue's payload is bytes, not text: a lossy
          // utf-8 decode would replace the ones the run id has to be found in.
          body: Buffer.concat(chunks).toString("latin1"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => executor.listen(0, "127.0.0.1", () => resolve()));
    const address = executor.address();
    if (address === null || typeof address === "string") {
      throw new Error("the recording executor did not bind a TCP port");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  /**
   * Idempotent, because the second-process case has to close the world early.
   *
   * It must happen before the database is dropped: the world's `pg` pool has no
   * `error` listener, so a connection terminated under it surfaces as an
   * uncaught exception and fails the run for a reason that is not a finding.
   */
  async function closeWorld(): Promise<void> {
    if (worldClosed) return;
    worldClosed = true;
    const runtime = await import(pathToFileURL(WORLD_RUNTIME).href);
    const world: { close?: () => Promise<void> } = runtime.getWorld();
    await world.close?.();
  }

  /**
   * Wait until a flow message has reached the executor.
   *
   * A throw rather than an `expect`, because this runs in a hook: an assertion
   * there is reported against whichever test happens to be next, which is the
   * shape `noMisplacedAssertion` exists to stop.
   */
  function waitForFlowDispatch(): Promise<void> {
    return vi.waitFor(
      () => {
        if (!executorCalls.some((call) => call.path === FLOW_ROUTE)) {
          throw new Error("no flow message has been dispatched to the executor yet");
        }
      },
      { timeout: 60_000, interval: 100 },
    );
  }

  /**
   * Point the world's queue at OUR executor.
   *
   * `vi.stubEnv` so `unstubEnvs` reverts it; re-applied per test because that
   * revert runs before every one. `WORKFLOW_TARGET_WORLD` and
   * `WORKFLOW_POSTGRES_URL` are deliberately NOT stubbed —
   * `configureWorkflowWorld` writes those itself, and having it do so is half of
   * what this file checks.
   */
  function stubExecutorEnv(): void {
    // The postgres world resolves its executor from `WORKFLOW_LOCAL_BASE_URL`,
    // then `PORT`, then a port SCAN. Pinning it is what keeps the dispatch
    // deterministic — the scan would probe whatever else is listening on this
    // machine.
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", executorOrigin);
  }

  beforeEach(stubExecutorEnv);

  beforeAll(async () => {
    admin = createPostgresDb({ url: pgUrl(), max: 1 });
    // `with (force)` terminates whatever a previous run left connected, which is
    // what makes a re-run idempotent rather than a "database is being accessed
    // by other users" failure.
    await admin.query(`drop database if exists ${DB_NAME} with (force)`);
    await admin.query(`create database ${DB_NAME}`);
    worldUrl = new URL(`/${DB_NAME}`, pgUrl()).toString();
    db = createPostgresDb({ url: worldUrl, max: 2 });

    executorOrigin = await startExecutor();
    stubExecutorEnv();

    // ORDER IS THE POINT: configure, then start. Reversed, the world memoizes
    // before it has been told anything and the guest silently runs local.
    derivedKind = configureWorkflowWorld({ databaseUrl: worldUrl, port: 0 });
    // `configureWorkflowWorld` writes the BARE package name, which cannot be
    // resolved from this CWD (see WORLD_MODULE). Re-spelling it as the absolute
    // path is the only deviation from what a guest does, and the case below
    // asserts that spelling is still classified — and therefore migrated — as
    // postgres.
    process.env.WORKFLOW_TARGET_WORLD = WORLD_MODULE;
    suppliedKind = configureWorkflowWorld({ databaseUrl: worldUrl, port: 0 });

    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      reported.push(args.map(String).join(" "));
    });
    try {
      await startWorkflowWorldIfDeclared(true, "postgres");
      runId = await wdkAdapter().start(WORKFLOW_ID, [{ topic: "durability" }]);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }

    // The queue dials the executor, so a dispatch arriving is what proves a
    // runner is polling at all. Waited for here rather than in the case that
    // asserts it, so the cases stay pure assertions over what happened — hence
    // a throw rather than an `expect`, which does not belong in a hook.
    await waitForFlowDispatch();
  }, 120_000);

  afterAll(async () => {
    await closeWorld();
    await new Promise<void>((resolve) => executor.close(() => resolve()));
    await db.close();
    await admin.query(`drop database if exists ${DB_NAME} with (force)`);
    await admin.close();
  });

  test("configureWorkflowWorld points the DevKit at the app's own database", () => {
    // What the live configuration answered, before any of it was re-spelled:
    // a database means Postgres, which is the branch this whole file runs on.
    expect(derivedKind).toBe("postgres");

    // The derivation, on an env object of this test's own rather than the
    // process — the reason that parameter exists. A database means Postgres, and
    // the URL is set EXPLICITLY rather than left to the world's `DATABASE_URL`
    // fallback.
    const env: NodeJS.ProcessEnv = {};
    expect(configureWorkflowWorld({ databaseUrl: worldUrl, port: 4711, env })).toBe("postgres");
    // A RESOLVED ABSOLUTE PATH, never the bare specifier. The DevKit `require`s
    // this value from its own compiled artifacts, which land in `tmpdir()` where
    // no `node_modules` sits above them — so a bare name fails naming a package
    // that is plainly installed (`aai/host/workflow-resolve.ts` owns the rule and
    // the error text). This expected the bare specifier for as long as the
    // resolution existed, and passed nowhere: it is a scenario test, so it only
    // runs where a database is resolved.
    expect(env.WORKFLOW_TARGET_WORLD).toMatch(/[/\\]@workflow[/\\]world-postgres[/\\]/);
    expect(env.WORKFLOW_TARGET_WORLD?.startsWith("/")).toBe(true);
    expect(env.WORKFLOW_POSTGRES_URL).toBe(worldUrl);
    // A local world's callback base URL has no meaning here and must not be
    // invented: setting it would repoint the queue's own dispatch.
    expect(env.WORKFLOW_LOCAL_BASE_URL).toBeUndefined();

    // And the live one, which the world running above really loaded.
    expect(process.env.WORKFLOW_POSTGRES_URL).toBe(worldUrl);
  });

  test("an absolute world path is classified — and so migrated — as postgres", () => {
    // The regression `classifySuppliedWorld` was written for: an exact-match
    // check read a resolved path as `local`, so the DevKit loaded a Postgres
    // world nobody had migrated and the log said `local`. Not a hypothetical
    // spelling here — it is the one this whole file runs on.
    expect(path.isAbsolute(WORLD_MODULE)).toBe(true);
    expect(WORLD_MODULE).toContain("@workflow/world-postgres");
    // The live one: the value the world above was really loaded from.
    expect(suppliedKind).toBe("postgres");
    const supplied: NodeJS.ProcessEnv = { WORKFLOW_TARGET_WORLD: WORLD_MODULE };
    expect(configureWorkflowWorld({ databaseUrl: undefined, port: 4711, env: supplied })).toBe(
      "postgres",
    );
    // A genuinely custom world still reads `local` — nothing here knows how to
    // migrate one, and guessing would be worse than declining.
    const custom: NodeJS.ProcessEnv = { WORKFLOW_TARGET_WORLD: "/opt/some-other-world" };
    expect(configureWorkflowWorld({ databaseUrl: undefined, port: 4711, env: custom })).toBe(
      "local",
    );
  });

  test("the migration runs to completion without ending the process", () => {
    // The `process.exit` stand-in, from the only angle that can see it: this
    // process is STILL HERE. `setupDatabase` reached its `process.exit(0)` —
    // the success line below is the statement two before it — and without the
    // stand-in that call would have ended this worker mid-suite, with vitest
    // reporting a crashed process rather than a failed assertion.
    expect(logged.join("\n")).toContain("Database schema created successfully");
    expect(reported).toContain("harness starting postgres workflow world");
  });

  test("the migration really created the world's schema", async () => {
    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'workflow' order by table_name`,
    );
    // The table every durability claim in this repo ultimately rests on.
    expect(tables.map((row) => row.table_name)).toContain("workflow_runs");

    // Drizzle's own ledger, which is what makes the migration idempotent on the
    // next boot rather than a re-apply.
    const [applied] = await db.query<{ count: string }>(
      "select count(*)::text as count from workflow_drizzle.workflow_migrations",
    );
    expect(Number(applied?.count)).toBeGreaterThan(0);

    // The graphile-worker schema the same pass bootstraps. Without it the first
    // `start()` races the DDL, which is the failure its own comment describes.
    const [queue] = await db.query<{ present: boolean }>(
      `select exists (select 1 from information_schema.schemata
        where schema_name = 'graphile_worker') as present`,
    );
    expect(queue?.present).toBe(true);
  });

  test("a SUCCESSFUL migration is not reported as a failure", () => {
    // This case was written inverted, as a pin on a live defect, and is the half
    // of that bargain the fix owes: it now asserts the cure and fails if the bug
    // comes back. Keep it that way round.
    //
    // The defect: `migratePostgresWorld`'s doc reasons that the stand-in's throw
    // unwinds `setupDatabase`'s own await chain harmlessly because "the exit is
    // the last statement in both branches". It is — but the SUCCESS one is the
    // last statement inside a `try` whose `catch` calls `process.exit(1)`:
    //
    //     try  { …; console.log('✅ …'); await pool.end(); process.exit(0); }
    //     catch (error) { …; console.error('❌ Failed to setup database:', error);
    //                     process.exit(1); }
    //
    // So the stand-in threw, `setupDatabase` caught its own interception,
    // reported the migration as failed, and exited 1 — and `exitCode` was 1 by
    // the time `migratePostgresWorld` read it. Reproduced against
    // `@workflow/world-postgres@4.3.3` outside vitest as well as here.
    //
    // What it cost: the schema IS migrated, but `migrateAndSubscribe` threw
    // before `getWorld().start?.()`, so a booting guest never subscribed its
    // queue and never ran `reenqueueActiveRuns`. A run parked in a `sleep` or on
    // a webhook was not picked up when its guest was woken — hazard 2, live, and
    // exactly what the wake sweep exists to trigger. It also made the
    // orphaned-lock sweep dead code on every boot, since that runs between the
    // migration and the subscribe.
    //
    // The fix is that the stand-in keeps the FIRST exit code: a second `exit` is
    // the CLI reacting to our own interception, never a decision of its own.
    expect(logged.join("\n")).toContain("Database schema created successfully");
    expect(reported).toContain("harness starting postgres workflow world");

    // THE symptom, and the whole of what the fix cures: the world starts.
    // `startWorkflowWorldIfDeclared` reports a failure rather than throwing one,
    // so its absence from the log IS the assertion that `migrateAndSubscribe`
    // ran to the end — through the orphaned-lock sweep and `getWorld().start?.()`
    // rather than throwing before either.
    expect(reported.join("\n")).not.toContain("failed to start");
    expect(reported.join("\n")).not.toContain("the Postgres world migration failed");

    // And a successful migration says NOTHING about failing.
    //
    // This assertion used to be its own inverse, pinning the ❌ line as something
    // "the fix CANNOT remove … removing it means an upstream that stops exiting".
    // That reasoning was wrong, and the fix is smaller than the workaround it
    // replaced: the stand-in no longer THROWS. `process.exit` is the last
    // statement in both of `setupDatabase`'s branches, so recording the code and
    // RETURNING lets the function resolve — nothing reaches its `catch`, so there
    // is no interception for it to report as a database failure. A real failure
    // still logs its own genuine error and still sets `exitCode` to 1.
    //
    // Kept as an assertion rather than deleted because the misleading line is the
    // symptom an operator would actually act on: a red "Failed to setup database"
    // with a stack trace, printed directly under "✅ … created successfully!", on
    // every workflow guest boot.
    expect(reported.join("\n")).not.toContain("Failed to setup database");
    expect(logged.join("\n")).not.toContain("Failed to setup database");
  });

  test("a run started through the SDK's own adapter is written to Postgres", async () => {
    // Hazard 3, and the assertion vercel/eve's `e2e-postgres.yml` makes for the
    // same reason: a non-zero count is the only positive evidence that traffic
    // reached the durable world rather than falling back to the local one.
    const [counted] = await db.query<{ count: string }>(
      "select count(*)::text as count from workflow.workflow_runs",
    );
    expect(Number(counted?.count)).toBeGreaterThan(0);

    // Not just "a row" — THIS run, under the id the client transform attaches,
    // read with SQL rather than through the API that wrote it.
    const rows = await db.query<{ name: string; status: string }>(
      "select name, status from workflow.workflow_runs where id = $1",
      [runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(WORKFLOW_ID);

    // And the same record through the adapter `ctx.workflows` is built on, so
    // the read path is exercised against a real world too.
    const record = await wdkAdapter().getRun(runId);
    expect(record?.runId).toBe(runId);
    expect(record?.workflowName).toBe(WORKFLOW_ID);

    // The local world's symptom, asserted by its absence: it writes run state
    // into `.workflow-data/` under the process CWD, one entry per run.
    //
    // Scoped to THIS run rather than to the directory existing at all. That
    // directory is gitignored, so any suite in this package — or a stray
    // `aai dev` — can leave one behind, and asserting on its absence made this
    // case fail for a reason that has nothing to do with the world under test.
    expect(await localWorldEntries()).not.toContain(runId);
  });

  test("enqueueing a run subscribes the queue, and its flow message is dispatched", () => {
    // Hazard 2's mechanism, from the half that is reachable today. The postgres
    // world's `queue()` awaits its own `start()`, so an enqueue brings the
    // graphile-worker runner up; a dispatch arriving on the executor is the
    // proof that a runner really polled and claimed the job. Without any
    // subscription this array stays empty and the run sits pending forever with
    // nothing logged — the failure `workflow-world.ts`'s doc describes.
    //
    // This is NOT the boot-time `getWorld().start?.()` call: that one is
    // unreachable while the defect above stands, and it is the one that also
    // runs `reenqueueActiveRuns` for runs nobody is enqueueing.
    expect(executorCalls.length).toBeGreaterThan(0);
    expect(executorCalls.map((call) => call.path)).toContain(FLOW_ROUTE);
    // The message carries the run it belongs to, so this is a dispatch OF this
    // run rather than the DevKit's own health probe.
    expect(executorCalls.some((call) => call.body.includes(runId))).toBe(true);
  });

  test("a second process reads the run back and re-enqueues it", async () => {
    // The durable half of "a run outlives the process that started it", and the
    // only part of it this package can reach — see the header for why the
    // hard-kill version belongs in `aai-cli`. The world that created the run is
    // CLOSED (pool gone, worker stopped) and a second OS process opens a fresh
    // one against the same database: it reads the run out of Postgres, and its
    // `start()` re-enqueues it, which is the call a replacement guest recovers
    // parked work through.
    await closeWorld();
    executorCalls = [];

    const dir = await fs.mkdtemp(path.join(tmpdir(), "aai-world-second-process-"));
    const script = path.join(dir, "read-run.mjs");
    await fs.writeFile(script, SECOND_PROCESS);
    const child = spawn(process.execPath, [script, WORLD_MODULE, worldUrl, runId], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WORKFLOW_LOCAL_BASE_URL: executorOrigin },
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      err += chunk;
    });

    try {
      // The fresh process READ the run — durable state, not this process's heap.
      await vi.waitFor(() => expect(out).toContain("\n"), { timeout: 60_000, interval: 100 });
      const parsed: unknown = JSON.parse(out.split("\n")[0] ?? "");
      expect(isRecord(parsed) && parsed.runId).toBe(runId);
      expect(isRecord(parsed) && parsed.workflowName).toBe(WORKFLOW_ID);

      // And it re-enqueued it: the dispatch below cannot have come from this
      // process, whose world is closed.
      await waitForFlowDispatch();
      expect(executorCalls.map((call) => call.path)).toContain(FLOW_ROUTE);
      expect(executorCalls.some((call) => call.body.includes(runId))).toBe(true);
      expect(err).not.toContain("MODULE_NOT_FOUND");
    } finally {
      child.kill("SIGKILL");
      // Let the kill land before `afterAll` drops the database under it.
      await sleep(200);
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
