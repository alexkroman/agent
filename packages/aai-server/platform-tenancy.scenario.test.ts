// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform's stores are TENANT-PARTITIONED — on a real Postgres, which is
 * the only arm that can prove it.
 *
 * > For any interleaving of writes across any two distinct slugs, no read issued
 * > for slug A ever returns, mutates, or deletes a row written under slug B.
 *
 * **This is the arm that matters, and it is the arm CI exercises least.** A
 * tenancy leak here lives in a `where` clause, so nothing short of a real
 * database can see one: an in-memory fake holds JS values and cannot be stricter
 * than the driver, and a recorder replays statement text without knowing whether
 * a predicate constrains. Meanwhile this file SKIPS without `AAI_TEST_PG_URL`
 * (announced, via `describeWithPg`), the platform schema needs the local Supabase
 * stack rather than a bare port, and a developer running `pnpm test` never
 * reaches it. Take that discount seriously: `platform-tenancy.test.ts` beside
 * this one exists to keep the property's discriminating power under a gate that
 * runs everywhere, and its six negative controls are what stop this file
 * degrading into a green run that checks nothing.
 *
 * If you are deciding whether to run `pnpm test:pg` locally, this is what you
 * are skipping — and it costs about ten seconds. A survey of this package's
 * arms put the general shape of that discount at nine of eighteen store-contract
 * arms reached by `pnpm test`; the tenancy partition is only ever checked in the
 * other half.
 *
 * ```sh
 * pnpm test:pg pnpm --filter aai-server vitest run --config ../../vitest.slow.config.ts
 * AAI_TEST_PG_URL=… pnpm --filter aai-server test:scenario
 * ```
 *
 * ## What is real, and why the oracle is a MODEL rather than a sibling store
 *
 * Real: twelve of `platform-workflow-journal.ts`'s thirteen methods (hooks
 * included; `readStep` is deliberately absent — it reads the same table through
 * the same slug-leading predicate as `readSteps`, and its tenancy is pinned by
 * hand in `platform-workflow-journal.scenario.test.ts` rather than generated
 * here, because extending this grammar perturbs coverage floors calibrated on
 * observed minimums),
 * `platform-uploads.ts`'s five, `platform-session-state.ts`'s six, every
 * statement they issue, and the shipped `aai_platform` schema with its primary
 * keys, its unique `(slug, token)` index and its cascades from `agents`.
 *
 * The oracle is `_tenancy-world-harness.ts`'s reference world, and the reason
 * that is not the usual differential trap is worth stating: a property comparing
 * two IMPLEMENTATIONS is blind to a defect they share, so a leak present in both
 * reads as green. This oracle is not an implementation. It is a
 * `Map<slug, Tables>` in which a row physically lives inside the bucket of the
 * tenant that wrote it, so a cross-tenant read, mutation or delete is
 * UNREPRESENTABLE. It cannot mirror a tenancy leak however the SQL is written —
 * the invariant is true of it by construction, which makes it the definition of
 * the invariant rather than a second opinion about it. The price is that a
 * mistake in the model's SEMANTICS shows up as a divergence, i.e. a false RED,
 * never a false green.
 *
 * ## Why the identifiers COLLIDE
 *
 * Run ids are `wf_`-prefixed opaque strings, so a cross-tenant collision is not
 * reachable by guessing — but it is reachable by a caller who CHOOSES one, and
 * `createRun` takes `run.runId` from the guest. Same for `claimAttempt`,
 * `claimSleep` and `appendStep` on `(slug, run_id, key)`, for `claimHook`'s
 * token, for `claimUpload`'s id and for every session id. So both tenants draw
 * every identifier from one shared pool and a fixed prologue plants a colliding
 * row of every kind before the generated interleaving begins — see
 * `_tenancy-ops-harness.ts`. A generator minting unique ids per tenant would
 * test the one world in which a leak has nothing to leak.
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import fc from "fast-check";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { emptyCensus, programArb, SLUGS } from "./_tenancy-ops-harness.ts";
import { createPlatformArm } from "./_tenancy-platform-harness.ts";
import { checkPartition, explain } from "./_tenancy-world-harness.ts";
import type { SqlExec } from "./secret-store.ts";
import { ensurePlatformTables } from "./test-utils.ts";

describeWithPg("the platform's stores over a real Postgres, two tenants at once", () => {
  let db: ReturnType<typeof createPostgresDb>;
  let sql: SqlExec;

  beforeAll(async () => {
    // `pgUrl()` inside the hook and never at the top of this body: vitest
    // EXECUTES a skipped describe's callback to enumerate what it is skipping,
    // so a read up there fails the file instead of skipping it.
    db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (query, params) => db.query(query, params);
    await ensurePlatformTables(sql);
  });

  afterAll(async () => {
    // Both tenants' rows go with their agents — every table here cascades from
    // `aai_platform.agents`.
    await sql("delete from aai_platform.agents where slug = any($1::text[])", [[...SLUGS]]);
    await db.close();
  });

  const seen = emptyCensus();

  test("never answer, move or delete across the slug boundary", async () => {
    const arm = createPlatformArm(sql);
    await fc.assert(
      fc.asyncProperty(programArb, async (ops) => {
        // `reset` (inside `checkPartition`) empties both tenants by deleting
        // their agents rows, so every run — including every shrink — starts
        // clean. A leftover row would converge the shrinker on contamination.
        const bad = await checkPartition(arm, ops, seen);
        expect(bad && explain(bad), "a statement crossed the slug boundary").toBeUndefined();
      }),
      { numRuns: 100 },
    );

    // Ranges over 20 runs at this `numRuns`, each floor set under the OBSERVED
    // MINIMUM. Measured on the REFERENCE arm rather than this one, deliberately
    // and legitimately: every counter is classified out of the reference's own
    // state (see `_tenancy-census-harness.ts`), so the distribution is a
    // property of the GENERATOR and identical on both arms — and measuring it
    // here would mean 2,000 runs against a real database to learn something that
    // costs three seconds in memory.
    //
    // `numRuns` is 100, the same as the unit arm, because the measurement said
    // it could be: 30 runs cost 2.7s against the local stack, so 100 is ~9s
    // inside a 120s tier. It was drafted at 30 and raised, because at 30 the
    // rarest state — the terminal release below — came out 4-13 over 20 samples
    // and reached ZERO before the grammar was weighted, and a floor that thin on
    // the one state the whole file exists for is not a floor.
    expect(seen.sharedRuns, "no op ever named a run id BOTH tenants held").toBeGreaterThan(800); // 948-992
    expect(
      seen.foreignRunReads,
      "no tenant ever read a run only its neighbour had",
    ).toBeGreaterThan(12); // 23-46
    expect(seen.sharedStepKeys, "no step was appended at a key the neighbour held").toBeGreaterThan(
      80,
    ); // 104-117
    expect(
      seen.sharedAttemptKeys,
      "no attempt was claimed on a counter the neighbour also had",
    ).toBeGreaterThan(80); // 105-120
    expect(
      seen.foreignSleepWakes,
      "no wake was issued for a run the neighbour had an unwoken sleep on",
    ).toBeGreaterThan(8); // 15-25
    expect(
      seen.foreignTokenDeliveries,
      "no delivery was attempted on a token only the neighbour held",
    ).toBeGreaterThan(4); // 10-30
    // THE state: a terminal `setStatus` whose `released` CTE runs while the
    // NEIGHBOUR holds a hook on the same colliding run id. Deleting
    // `h.slug = $1` from that CTE leaves a statement a grep still passes, and
    // this is the only counter that says a run entered the state which catches
    // it.
    expect(
      seen.terminalWithForeignHook,
      "no run went terminal while the neighbour held a hook on the same run id",
    ).toBeGreaterThan(14); // 27-48
    expect(
      seen.foreignUploadWrites,
      "no upload write landed on an id only the neighbour held",
    ).toBeGreaterThan(12); // 22-46
    expect(
      seen.foreignSessionDiscards,
      "no session was discarded while the neighbour had rows under it",
    ).toBeGreaterThan(14); // 25-39
    expect(seen.refusals, "no caller-chosen id was ever refused").toBeGreaterThan(28); // 49-81
  });
});
