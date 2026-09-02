// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform's stores are TENANT-PARTITIONED, in the tier that runs everywhere.
 *
 * > For any interleaving of writes across any two distinct slugs, no read issued
 * > for slug A ever returns, mutates, or deletes a row written under slug B.
 *
 * Four modules assert this in prose and none of them encodes it:
 * `platform-workflow-journal.ts` ("there is no query here that can be pointed at
 * another agent's rows, so there is no check to forget"),
 * `platform-workflow-journal-hooks.ts`, `platform-uploads.ts` ("a row leaked here
 * is a map to another tenant's audio") and `platform-session-state.ts`. A review
 * verified by hand that all twelve journal methods lead with `slug = $1` and
 * found tenancy sound. What was missing is the CLAIM.
 *
 * ## Why the file next to this one is the one that matters
 *
 * `platform-tenancy.scenario.test.ts` runs this same property over the real
 * statements against a real Postgres, and that is the only arm that can see a
 * leak in the SQL, because a leak of this class lives in a `where` clause. THIS
 * file cannot: there is no in-process implementation of those statements to run.
 *
 * What it does instead is prove the property has TEETH — and that is not a
 * consolation prize, because the scenario arm is the arm CI exercises least. It
 * SKIPS without a database (`describeWithPg`, announced), it needs the local
 * Supabase stack rather than a port, and a developer running `pnpm test` never
 * touches it. So the discrimination the whole exercise rests on is asserted
 * here, where it runs on every push:
 *
 * - the reference world is partitioned and the generated corpus really enters
 *   the collision states (the floors);
 * - and for each of six ways to lose a tenancy predicate — `hook-release` being
 *   `setStatus`'s `released` CTE losing `h.slug = $1`, the leak no text gate can
 *   see — the property FAILS.
 *
 * A grep is not an alternative to either half. `setStatus` contains `slug = $1`
 * twice, once for `workflow_runs` in `moved` and once for `workflow_hooks` in
 * `released`; delete the second and the statement still matches, so a
 * per-statement text gate reports a tenancy predicate that no longer constrains
 * the delete. Both of that leak's halves are measured — see
 * `_tenancy-census-harness.ts`'s `terminalWithForeignHook`.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { emptyCensus, programArb } from "./_tenancy-ops-harness.ts";
import {
  checkPartition,
  createReferenceWorld,
  explain,
  type Leak,
} from "./_tenancy-world-harness.ts";

/** Shared by every run of the property below, so the floors see the whole corpus. */
const seen = emptyCensus();

describe("two tenants sharing every identifier", () => {
  test("cannot see, move or delete each other's rows in the reference world", async () => {
    // The reference against a second, independently built reference. Green by
    // construction — a row lives inside the bucket of the tenant that wrote it,
    // so a cross-tenant answer is unrepresentable — and it is still worth
    // running: it is what proves `checkPartition` does not fail SPURIOUSLY (the
    // model is deterministic, its dumps canonical, its answers stable), which is
    // the assumption every negative control below rests on. The load-bearing
    // half is the floors.
    await fc.assert(
      fc.asyncProperty(programArb, async (ops) => {
        const bad = await checkPartition(createReferenceWorld(), ops, seen);
        expect(bad && explain(bad), "the reference diverged from itself").toBeUndefined();
      }),
      { numRuns: 100 },
    );

    // Ranges over 20 runs of this test at this `numRuns`, each floor set under
    // the OBSERVED MINIMUM — never a fraction of a mean, because what a program
    // reaches is correlated within a run rather than independent per op.
    //
    // Every one counts a COLLISION state: a run in which the two tenants never
    // named the same row satisfies the invariant trivially, so a floor on "ops
    // issued" would be exactly the compliance floor `check:property-floors`
    // exists to discourage.
    expect(seen.sharedRuns, "no op ever named a run id BOTH tenants held").toBeGreaterThan(800); // 948-992
    expect(
      seen.foreignRunReads,
      "no tenant ever read a run only its neighbour had",
    ).toBeGreaterThan(12); // 23-46
    // These two track each other closely, and deliberately stay separate: they
    // are different STATEMENTS over different tables (`appendStep`'s primary key
    // against `claimAttempt`'s conflict target), so one of them going to zero
    // while the other holds is what a weight change or a grammar edit looks
    // like. The near-identity is an artefact of their equal weights, not shared
    // information.
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
    // THE state, and the reason this file exists — see `Census`.
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

  /**
   * One dropped predicate per case, each modelled on a real line of the code
   * under test. `createReferenceWorld(leak)` is otherwise the same world, so the
   * only difference between a passing and a failing run is the predicate.
   */
  const LEAKS: readonly Leak[] = [
    "flat",
    "hook-release",
    "hook-delivery",
    "attempt-conflict",
    "session-discard",
    "run-read",
  ];

  // A FIXED SEED, which is deliberate and is the one place in this file where it
  // is right: the claim is "this property detects this leak", and a negative
  // control that detects it only on lucky seeds is not a control. A fresh seed
  // per run would make these six tests flake at whatever rate the triggering
  // collision fails to be generated.
  test.each(LEAKS)("the property FAILS when %s loses its tenancy predicate", async (leak) => {
    const run = await fc.check(
      fc.asyncProperty(programArb, async (ops) => {
        const bad = await checkPartition(createReferenceWorld(leak), ops, emptyCensus());
        expect(bad && explain(bad), `${leak} leaked`).toBeUndefined();
      }),
      { numRuns: 200, seed: 20_260_901 },
    );
    expect(
      run.failed,
      `a world with the ${leak} predicate dropped passed the tenancy property — ` +
        "the generator no longer reaches the state that leak needs, which is a gap " +
        "in the grammar and matters more than the leaks it does catch",
    ).toBe(true);
    // Shrinking is left ON (no `endOnFailure`): it costs nothing in memory and
    // the shrunk program is what makes a real counterexample readable rather
    // than a 25-op wall.
    expect(run.counterexample, "the failure produced no counterexample").not.toBeNull();
  });
});
