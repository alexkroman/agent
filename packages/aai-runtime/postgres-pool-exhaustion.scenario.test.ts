// Copyright 2026 the AAI authors. MIT license.
/**
 * A pool with nothing to give, against the real driver.
 *
 * `reserveTimeoutMs` is specced against a mocked `postgres` in
 * `postgres-db.test.ts`, and that suite cannot make either claim this one is
 * about, because both are properties of postgres.js rather than of our wrapper:
 * that `sql.reserve()` really does QUEUE at `max` rather than failing or opening
 * an extra connection — the premise the whole option rests on — and that the
 * reservation the driver eventually hands to an abandoned waiter can be
 * released back into the pool. The second is what decides whether the option
 * relieves a shortage or makes it permanent: `pTimeout` settles the caller and
 * leaves the driver's promise running, so a wrapper that dropped the late
 * reservation would retire one connection of four on every expiry.
 *
 * ## What it costs the database: one connection and no rows
 *
 * `max: 1`, `select 1`, and nothing written — which is deliberate, this tier
 * running against whatever local Postgres a developer has. There is no schema
 * to set up and nothing to clean up.
 *
 * The deadline is 300 ms rather than the platform's 5 s so a case is quick, and
 * every WAIT here is bounded by {@link attemptReserve} rather than by the
 * suite's timeout: the regression this guards is an unbounded queue, so a spec
 * that expressed it as a bare `await` would HANG for two minutes instead of
 * failing with a sentence.
 */

import pTimeout from "p-timeout";
import { expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { type CloseableDb, createPostgresDb, type ReservedDb } from "./postgres-db.ts";

/** How long a case waits before calling a queued reservation hung. */
const HUNG_AFTER_MS = 5000;

/**
 * Close the pool, and do not let the CLOSE be what a regression costs.
 *
 * `sql.end()` drains, so it waits out every connection still reserved — and a
 * case that has just failed is precisely the one holding some. Measured: with
 * the deadline removed, the first case failed correctly at 5 s and then sat in
 * teardown for the tier's full 120-second budget, which turns a one-sentence
 * finding into a two-minute one. The drain is not the claim; abandoning it
 * costs a socket the process is about to exit with.
 */
async function closePool(db: CloseableDb): Promise<void> {
  await pTimeout(db.close(), { milliseconds: HUNG_AFTER_MS, fallback: () => undefined });
}

/**
 * What `reserve()` did — the granted handle, the error, or the fact that it is
 * still queueing.
 *
 * Three outcomes rather than two, so a regression reports "still queueing after
 * 5s" instead of running out the tier's 120-second budget with no finding. A
 * UNION rather than `unknown`, so the cases narrow to a `ReservedDb` by ruling
 * the other two out instead of casting to one.
 */
type ReserveOutcome = ReservedDb | Error | string;

async function attemptReserve(db: CloseableDb): Promise<ReserveOutcome> {
  return await pTimeout(db.reserve(), {
    milliseconds: HUNG_AFTER_MS,
    fallback: () => `still queueing after ${HUNG_AFTER_MS}ms`,
  }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
}

/**
 * The handle, or a failure naming what came back instead.
 *
 * THROWS rather than calling `expect.fail`, for the reason `_pg-test-utils.ts`
 * gives for the same shape: an assertion outside a test body is Biome's
 * `noMisplacedAssertion`, and a throw fails the case that called it with the
 * same sentence.
 */
function granted(outcome: ReserveOutcome, what: string): ReservedDb {
  if (outcome instanceof Error || typeof outcome === "string") {
    throw new Error(`${what}: ${String(outcome)}`);
  }
  return outcome;
}

describeWithPg("a Postgres pool with every connection taken", () => {
  test("refuses a reservation past its deadline, and is WHOLE afterwards", async () => {
    const db = createPostgresDb({ url: pgUrl(), max: 1, reserveTimeoutMs: 300 });
    // The pool's only connection, out of the pool — and released in the
    // `finally` as well as below, `release` being idempotent, so a failure
    // between here and there does not leave the drain nothing to wait for.
    const held = await db.reserve();
    try {
      await expect(held.query("select 1 as n")).resolves.toEqual([{ n: 1 }]);

      // Unbounded, this is where a guest platform request used to sit until the
      // guest's own 10-15s deadline fired — a timeout with no status, blamed on
      // a journal the request never reached.
      expect(await attemptReserve(db)).toMatchObject({ code: "POOL_EXHAUSTED" });

      // The half that makes it a relief rather than a ratchet: the abandoned
      // wait is still pending inside the driver, and releasing the holder is
      // what hands it a connection. If that one were dropped rather than
      // released, this pool of one would now have nothing left to give and the
      // reservation below would time out too.
      held.release();
      const again = granted(await attemptReserve(db), "the pool did not recover");
      await expect(again.query("select 1 as n")).resolves.toEqual([{ n: 1 }]);
      again.release();
    } finally {
      held.release();
      await closePool(db);
    }
  });

  test("with NO deadline the wait queues and is granted, which the slug lock needs", async () => {
    // The premise under the option, and the behaviour the platform's slug-lock
    // pool depends on: a fifth concurrent deploy waits for a connection rather
    // than failing, however long the holder takes.
    const db = createPostgresDb({ url: pgUrl(), max: 1 });
    const held = await db.reserve();
    try {
      const queued = attemptReserve(db);
      let settled = false;
      void queued.then(() => {
        settled = true;
      });
      // Nothing but the release can settle it — no deadline is going to.
      await Promise.resolve();
      expect(settled).toBe(false);

      held.release();
      granted(await queued, "an unbounded reserve must be granted").release();
    } finally {
      held.release();
      await closePool(db);
    }
  });
});
