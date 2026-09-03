// Copyright 2026 the AAI authors. MIT license.
/**
 * The journal contract's FOURTH arm: `createPlatformJournal` over the REAL
 * handler and a real Postgres.
 *
 * `aai-runtime/journal-conformance.ts` owns the case list and the argument for
 * the pattern; read it first. What this file adds is the one arm that package
 * cannot stand up, and the gap it closes is not incidental — it is the reason a
 * conformance table can report green over a broken backend:
 *
 * - the **memory** arm is the reference;
 * - the **postgres** arm is the self-hosted store against a database;
 * - the **platform** arm in the unit tier is `createPlatformJournal` over a
 *   FAKE transport that decodes what the handler decodes and then delegates
 *   every SEMANTIC to the memory reference. Its own header says so. So it tests
 *   the guest side of the wire — the codec, `toRun`/`toStep`, the
 *   count-as-string — and **cannot represent a single bug the platform's own SQL
 *   has actually shipped**;
 * - **this** arm is that last mile: the runtime's client, the real
 *   `POST /:slug/workflow-journal` route with its bearer check and its body
 *   parsing, `platform-workflow-journal.ts`'s statements, and the platform's own
 *   tables under `aai_platform`.
 *
 * It found one on the day it was written. `createRun` was
 * `on conflict (slug, run_id) do nothing` with no `returning`, so a duplicate run
 * id was answered with SUCCESS while the interface says "rejects if `runId`
 * already exists", memory throws and the self-hosted store trips its primary key.
 * Two racing starts on one id both believed they had won and the loser's `input`
 * was silently discarded — on the platform arm only, i.e. for every deployed
 * agent. The shared case `createRun REFUSES a second run on the same id` had been
 * green over the memory-backed fake since the day it was written.
 *
 * ## What is REAL here, and what is not
 *
 * Real: the route, the guest bearer, the JSON body contract, every statement, and
 * the platform's schema (`ensurePlatformTables`, i.e. the shipped migrations).
 * Not real, deliberately: the bundle store is the in-memory one, because what an
 * agents ROW is for on this route is a version to derive a bearer from — so the
 * FK target the journal tables cascade from is seeded straight into Postgres
 * beside it. And `fakeAdminDbOver` stands in for the reserved-connection pool: a
 * journal statement takes no advisory lock, so what `withReserved` contributes to
 * these cases is its error mapping, which is exercised for real.
 *
 * ```sh
 * pnpm test:pg pnpm --filter aai-server test:scenario
 * ```
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { createPlatformJournal, loadJournalConformance } from "@alexkroman1/aai-runtime/internal";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { ensurePlatformTables } from "./platform-schema-test-utils.ts";
import type { SqlExec } from "./secret-store.ts";
import {
  bearerFor,
  createTestOrchestrator,
  deploy,
  fakeAdminDbOver,
  type TestFetch,
} from "./test-utils.ts";

/**
 * Awaited at the TOP, so the cases can be declared synchronously inside the
 * `describe` body below — which is what a suite body needs.
 *
 * A LOADER rather than a plain import because the case modules pull `vitest`,
 * which is an optional peer of a package whose `/internal` subpath is imported
 * for VALUES by the published CLI. `aai-runtime/internal.ts` carries the
 * measurement.
 */
const { journalConformance, journalIds } = await loadJournalConformance();

/** This arm's tenant. Its own slug, so nothing it writes is another suite's. */
const SLUG = "journal-conformance-arm";

describeWithPg("the journal contract over the platform's REAL handler", () => {
  let db: ReturnType<typeof createPostgresDb>;
  let sql: SqlExec;
  let journal: ReturnType<typeof createPlatformJournal>;
  /** The route as an HTTP surface, for the one claim the client hides: a STATUS. */
  let call: (body: unknown) => Promise<Response>;

  beforeAll(async () => {
    // `pgUrl()` inside the hook and never at the top of this body: vitest
    // EXECUTES a skipped describe's callback to enumerate what it is skipping,
    // so a read up there fails the file instead of skipping it.
    db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (query, params) => db.query(query, params);
    await ensurePlatformTables(sql);

    const harness = await createTestOrchestrator({ adminDb: fakeAdminDbOver(sql) });
    await deploy(harness.fetch, { key: "key1", body: { slug: SLUG } });
    // The agents row the journal's tables cascade FROM. The orchestrator above
    // keeps its own copy in the memory bundle store, which is where the bearer's
    // version comes from; this is the foreign key, and it has to be a real row in
    // the real database or every `createRun` fails on it. The columns are the
    // shipped table's NOT NULLs with no default, listed rather than derived so a
    // new required column fails here instead of six statements later.
    await sql(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
      [SLUG],
    );

    const token = await bearerFor(harness.store, SLUG);
    call = (body) =>
      harness.fetch(`/${SLUG}/workflow-journal`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    journal = createPlatformJournal({
      // The base is slug-scoped exactly as `AAI_PLATFORM_BASE_URL` is in a
      // guest's boot env, so the client composes the same path a deployed guest
      // does and cannot name another tenant's.
      base: `/${SLUG}`,
      token,
      fetch: routeFetch(harness.fetch),
    });
  });

  afterAll(async () => {
    // The agents row takes every journal row with it — the cascade this suite's
    // sibling asserts. A case that left rows behind would collide with the next
    // run of this file on the same database, which is what `uid()` exists for.
    await sql?.("delete from aai_platform.agents where slug = $1", [SLUG]);
    await db?.close();
  });

  test("a duplicate run id is answered 409, not 503", async () => {
    // The case list can only assert that `createRun` REJECTS; what the engine
    // acts on is the STATUS, and 503 is the answer that says "retry" — so the
    // guest would spend the message's whole attempt budget on a run id that is
    // going to go on existing. Asserted through the route rather than through the
    // client, because the client folds every non-2xx into one `Error`.
    const record = {
      method: "createRun",
      runId: `wrun-status-${journalIds("st")()}`,
      workflow: "digest",
      status: "pending",
      createdAt: Date.now(),
      input: `{"topic":"otters"}`,
    };
    expect((await call(record)).status).toBe(200);
    const again = await call({ ...record, input: `{"topic":"badgers"}` });
    expect(again.status).toBe(409);
    // The message names the cause. `workflow-journal call failed` — the generic
    // arm's — could not, which is half of why the typed error exists.
    expect(await again.text()).toContain("already exists");
  });

  // ONE store across every case — a scenario arm cannot afford a database per
  // test — which is exactly why every case mints its keys from `uid()`.
  journalConformance({
    label: "platform (real handler, real Postgres)",
    journal: () => journal,
    uid: journalIds("pf"),
    // Same omission as the unit platform arm, and for the same reason: the
    // CLIENT is what declares the method, so a real route underneath does not
    // change the answer. There is no `POST … {method:"resumableRuns"}` to reach
    // even if it did — a deployed run's recovery is the platform queue's
    // reconcile. The resume half is EXCLUDED here, out loud.
    resumable: false,
  });
});

/**
 * The orchestrator's `app.request` as the client's `fetch` seam.
 *
 * The client builds one relative URL per call and hands it to whatever `fetch` it
 * was given, so the request really is parsed, routed and authorized by Hono — no
 * handler is called directly here.
 */
function routeFetch(fetch: TestFetch): typeof globalThis.fetch {
  return async (input, init) => await fetch(String(input), init);
}
