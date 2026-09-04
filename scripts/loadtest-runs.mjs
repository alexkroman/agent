#!/usr/bin/env node
// Durable RUNS under load: start N of them at a fixed concurrency and time each
// one to a terminal status.
//
//   pnpm loadtest:runs --port=4960 --workflow=chain  --input='{"steps":10}'
//   pnpm loadtest:runs --port=4960 --workflow=fanout --input='{"url":"http://127.0.0.1:4950","items":32,"width":8}'
//   pnpm loadtest:runs --port=4960 --workflow=nap    --input='{"ms":500}' --runs=20
//
// `scripts/loadtest.mjs --scenario=workflow` measures the API — POST a run, read
// it back — and deliberately stops there: its runs are expected to die at a step
// that wants a provider key. This measures the ENGINE, all the way to a terminal
// status, against `loadtest-workflow-agent`, whose steps reach no vendor.
//
// So the number here is enqueue + claim + execute + journal + resume, N times,
// and the three workflows separate the parts: `chain` is the per-step round trip
// with no I/O, `fanout` is `mapConcurrent` over `stepFetch`, `nap` is a suspend
// and a resume. Run them one at a time — a mixed load reports a mean nobody can
// act on.
//
// It needs `aai dev` (or `npm start`), never the single-process stub host: a
// `"use workflow"` body is durable only after the WDK builder has transformed
// it, and untransformed it runs inline with no journal to measure. With no
// `DATABASE_URL` the world is in-memory and every number is a floor rather than
// a measurement — the run says which it got.
//
// Closed-loop: a worker starts one run, polls it to terminal, and starts the
// next. Open-loop would queue a backlog the engine never agreed to and report
// the queue instead of the engine.
//
// ## What it measured, so a rerun has something to disagree with
//
// On `aai dev` against a local Postgres 16, 4 cores:
//
//   ~38ms PER JOURNALED STEP, plus ~90ms of run setup. `chain` at 1/5/20/50
//   steps: 133 / 344 / 1092 / 2133ms p50, i.e. a marginal 35-52ms whatever the
//   length. That is the number a 60-segment fan-out pays 60 times over before
//   any work happens.
//
//   A DURABLE SLEEP RESOLVES ON A ~1s TICK. `nap` at 1ms, 100ms and 1000ms all
//   land at ~1120ms; 1500 and 2000 both at ~2130; 2600 at ~3125. So it is
//   ceil(ms/1000) seconds with a 1s floor — graphile-worker's timer poll, and
//   NOT the step-to-step path, which pays the 38ms above rather than a second.
//   Fine for `podcast-digest`'s multi-day schedule, an order of magnitude of
//   overshoot for a saga sleeping 100ms between attempts.
//
//   A FAN-OUT EXECUTES THREE WIDE whatever the window asks for, because
//   `APP_DB_WORLD_WORKER_CONCURRENCY` is 3. 16 steps each awaiting a 2s loopback
//   response, window 16: 12.3s (2.6x). With
//   `WORKFLOW_POSTGRES_WORKER_CONCURRENCY=12` and
//   `WORKFLOW_POSTGRES_MAX_POOL_SIZE=13` in the SERVER's environment: 4.4s
//   (7.3x). Against a fast far side a wide window is worse than a narrow one —
//   32 loopback steps, 903ms at window 2 against 1587ms at window 16.
//
// The last one is the finding worth keeping: the window is the body's request
// and the world's worker count is the answer, so size a window against the far
// side's latency rather than the item count. `sdk/app-db-budget.ts` argues why
// the default is 3 and who may raise it.
//
// Global `fetch` (Node 22+), so this has no dependencies.

import { valueReader } from "./_args.mjs";

const arg = valueReader(process.argv.slice(2));

const PORT = arg("port", "4960");
const BASE = arg("base", `http://127.0.0.1:${PORT}`);
const WORKFLOW = arg("workflow", "chain");
// `String(...)`: a bare `--input` reads as `true` (see `valueReader`), which
// `JSON.parse` would accept as the boolean `true` rather than an object.
const INPUT = JSON.parse(String(arg("input", '{"steps":10}')));
const RUNS = Number(arg("runs", "20"));
const CONCURRENCY = Number(arg("concurrency", "4"));
const POLL_MS = Number(arg("poll", "50"));
const TIMEOUT_MS = Number(arg("timeout", "120")) * 1000;

/** The statuses a run stops at — anything else is still going. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const pct = (sorted, p) =>
  sorted.length > 0
    ? Number(
        sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(1),
      )
    : 0;

/**
 * The poll wait.
 *
 * `guard-invariants` rule 19 bans a hand-rolled sleep and names
 * `@alexkroman1/aai/internal`'s as the remedy; this occurrence is BASELINED
 * because that remedy is unreachable here and every alternative destroys the
 * measurement. The repo root resolves no `@alexkroman1/*` (there is no root
 * dependency on them, deliberately), a relative import into `packages/aai` is
 * refused by Biome's `noRestrictedImports`, and this script must run against a
 * server that is not necessarily this repo's checkout.
 *
 * The three timer-free ways to wait for a run all cost more than they save:
 * `GET /workflows/runs/:id/events` polls at `RUN_EVENT_POLL_MS` (1000ms) and
 * `POST … {wait}` at `WORKFLOW_WAIT_POLL_MS` (250ms), either of which reports a
 * 133ms one-step run as a quarter- or whole-second one; and a poll loop with no
 * wait at all issues ~300-1000 requests a second per worker against the very
 * server under test, which measured ~3300 rps in total for `/health`.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One run, start to terminal. Answers what it cost and how it ended. */
async function oneRun() {
  const at = performance.now();
  const start = await fetch(`${BASE}/workflows/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow: WORKFLOW, input: INPUT }),
  });
  const started = /** @type {{ runId?: string }} */ (await start.json());
  if (!start.ok)
    throw new Error(`start HTTP ${start.status}: ${JSON.stringify(started).slice(0, 120)}`);
  if (!started.runId) throw new Error("start returned no runId");
  const startedMs = performance.now() - at;

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const read = await fetch(`${BASE}/workflows/runs/${started.runId}`);
    const snapshot = /** @type {{ status?: string, error?: unknown }} */ (await read.json());
    if (!read.ok) throw new Error(`read HTTP ${read.status}`);
    // A response with no `status` at all is not terminal, which is what the
    // bare `has(undefined)` meant — said so that the returned `status` is a
    // string rather than `string | undefined`.
    const status = snapshot.status;
    if (status !== undefined && TERMINAL.has(status)) {
      return {
        startedMs,
        totalMs: performance.now() - at,
        status,
        // A failed run's reason, capped. The whole point of reading it is to
        // notice that "completed" was really "failed 40 times, quickly" —
        // `undefined` rather than an absent key, because the one reader below
        // tests it either way and a conditional spread here is `guard-invariants`
        // rule 22.
        error: snapshot.error === undefined ? undefined : String(snapshot.error).slice(0, 120),
      };
    }
    await sleep(POLL_MS);
  }
  throw new Error(`run ${started.runId} still ${WORKFLOW} after ${TIMEOUT_MS}ms`);
}

const latencies = [];
const starts = [];
const statuses = new Map();
const errors = new Map();
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

let issued = 0;
const began = Date.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (issued < RUNS) {
      issued += 1;
      try {
        const result = await oneRun();
        latencies.push(result.totalMs);
        starts.push(result.startedMs);
        bump(statuses, result.error ? `${result.status}: ${result.error}` : result.status);
      } catch (err) {
        bump(errors, String(err?.message ?? err).slice(0, 120));
      }
    }
  }),
);
const elapsedMs = Date.now() - began;

const sortedTotal = [...latencies].sort((a, b) => a - b);
const sortedStart = [...starts].sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      base: BASE,
      workflow: WORKFLOW,
      input: INPUT,
      concurrency: CONCURRENCY,
      runs: RUNS,
      settled: latencies.length,
      seconds: Number((elapsedMs / 1000).toFixed(1)),
      runsPerSec: Number(((latencies.length / elapsedMs) * 1000).toFixed(2)),
      // The POST alone, because a slow `start` and a slow RUN are different
      // problems and a single total cannot tell them apart.
      startMs: { p50: pct(sortedStart, 50), p90: pct(sortedStart, 90), max: pct(sortedStart, 100) },
      totalMs: {
        p50: pct(sortedTotal, 50),
        p90: pct(sortedTotal, 90),
        p99: pct(sortedTotal, 99),
        max: pct(sortedTotal, 100),
      },
      statuses: Object.fromEntries(statuses),
      errors: Object.fromEntries(errors),
    },
    null,
    2,
  ),
);
