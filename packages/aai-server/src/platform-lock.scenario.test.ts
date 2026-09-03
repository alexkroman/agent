// Copyright 2026 the AAI authors. MIT license.
/**
 * The per-slug mutation lock against a REAL Postgres.
 *
 * `platform-lock.test.ts` drives `createPgSlugLock` through a fake `AdminDb`,
 * which can only check that the right SQL is issued in the right order. Every
 * property that makes the lock actually exclude anything is a property of
 * POSTGRES, asserted in that module's prose and nowhere else:
 *
 * - a reserved connection gives acquire and release the same session, so the
 *   lock is held by whoever thinks it holds it;
 * - `lock_timeout` turns a contended acquire into `55P03`, which is the whole
 *   trigger for `SlugLockTimeoutError`;
 * - returning a reservation to the pool does NOT release the lock — the claim
 *   this module got backwards at first. A fake cannot catch it, and the
 *   consequence is a lock leaked onto an idle pooled connection;
 * - a DROPPED connection DOES release it, which is the entire crashed-replica
 *   backstop that let the lease table and its pg_cron sweep be deleted.
 *
 * ## The contending holder is a raw session, not a second lock instance
 *
 * `createPgSlugLock` takes the module-level in-process `withSlugLock` FIRST,
 * and that mutex is shared by every instance in the process — so two
 * `createPgSlugLock`s here would queue on a local mutex with no deadline and
 * never reach Postgres at all (the first draft of this file hung on exactly
 * that). A hand-taken `pg_advisory_lock` on its own connection is both the
 * fix and the faithful model: at the database level, "another replica" IS
 * just another session.
 *
 * Runs in the SCENARIO tier (`pnpm test:scenario`, or `pnpm test:pg` to resolve
 * a database first) against `AAI_TEST_PG_URL`. No pgmq/pg_cron needed —
 * advisory locks are core Postgres, so any server will do. This package
 * declares no `check:integration`; `AAI_REQUIRE_PG` — the variable that turns a
 * skip into a failure — is declared under `check:scenario` in `turbo.json`.
 */

import { sleep } from "@alexkroman1/aai/internal";
import type { CloseableDb, ReservedDb } from "@alexkroman1/aai-runtime";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import {
  createPgSlugLock,
  SLUG_LOCK_NAMESPACE,
  SlugLockTimeoutError,
  type SlugMutationLock,
} from "./platform-lock.ts";

const ACQUIRE = "select pg_advisory_lock($1::int, hashtext($2)::int)";
const TRY = "select pg_try_advisory_lock($1::int, hashtext($2)::int) as got";
const UNLOCK = "select pg_advisory_unlock($1::int, hashtext($2)::int)";

describeWithPg("slug mutation lock over real Postgres advisory locks", () => {
  /** The pool under test — what a replica's `AdminDb` is. */
  let db: CloseableDb;
  /** A separate pool for the "other replica" and for probing. */
  let other: CloseableDb;
  let lock: SlugMutationLock;
  /** Connections a test parked a foreign lock on, released in afterEach. */
  let parked: { reserved: ReservedDb; slug: string }[] = [];

  /**
   * Read in `beforeAll`, not at the top of this body: vitest EXECUTES a
   * `describe.skip` callback (it has to, to enumerate the tests it is skipping),
   * so a `pgUrl()` up here would throw during collection on a machine with no
   * database instead of skipping.
   */
  let url: string;

  beforeAll(() => {
    url = pgUrl();
    // max:1 on the pool under test so a LEAKED reservation surfaces as a hang
    // rather than being absorbed by spare capacity.
    db = createPostgresDb({ url, max: 1 });
    other = createPostgresDb({ url, max: 4 });
    // A short deadline so the contention cases don't spend the real 15s.
    lock = createPgSlugLock(db, { acquireTimeoutMs: 300 });
  });

  afterEach(async () => {
    for (const { reserved, slug } of parked) {
      await reserved.query(UNLOCK, [SLUG_LOCK_NAMESPACE, slug]).catch(() => undefined);
      reserved.release();
    }
    parked = [];
  });

  afterAll(async () => {
    await Promise.all([db.close(), other.close()]);
  });

  /** Take the slug's lock from a foreign session — i.e. another replica. */
  async function holdElsewhere(slug: string): Promise<() => Promise<void>> {
    const reserved = await other.reserve();
    await reserved.query(ACQUIRE, [SLUG_LOCK_NAMESPACE, slug]);
    const entry = { reserved, slug };
    parked.push(entry);
    return async () => {
      await reserved.query(UNLOCK, [SLUG_LOCK_NAMESPACE, slug]);
      reserved.release();
      parked = parked.filter((p) => p !== entry);
    };
  }

  /**
   * Is the slug locked by SOMEONE? Asked with `pg_try_advisory_lock` from a
   * fresh session rather than by reading `pg_locks`: advisory locks are
   * re-entrant per session (so the asker must not be a holder), and `pg_locks`
   * stores the key in an unsigned `oid` column, which a negative `hashtext`
   * would not compare equal to.
   */
  async function isHeld(slug: string): Promise<boolean> {
    const reserved = await other.reserve();
    try {
      const rows = await reserved.query<{ got: boolean }>(TRY, [SLUG_LOCK_NAMESPACE, slug]);
      const got = rows[0]?.got === true;
      // A successful try TOOK the lock — hand it straight back.
      if (got) await reserved.query(UNLOCK, [SLUG_LOCK_NAMESPACE, slug]);
      return !got;
    } finally {
      reserved.release();
    }
  }

  test("waits for another replica's hold, then runs", async () => {
    const slug = `excl-${process.pid}`;
    const release = await holdElsewhere(slug);
    const order: string[] = [];

    // Deliberately no await: this must not resolve while the foreign session
    // holds the slug.
    const run = lock(slug, () => {
      order.push("ran");
      return Promise.resolve("done");
    });
    await sleep(120);
    expect(order).toEqual([]);

    await release();
    await expect(run).resolves.toBe("done");
    expect(order).toEqual(["ran"]);
  });

  test("an acquire past its deadline is a SlugLockTimeoutError, not a hang", async () => {
    const slug = `timeout-${process.pid}`;
    await holdElsewhere(slug);
    // 300ms deadline against a holder that never lets go: Postgres raises
    // 55P03, which the lock maps to the 409-shaped error the routes expect.
    await expect(lock(slug, () => Promise.resolve("never"))).rejects.toThrow(SlugLockTimeoutError);
    // The failed acquire must not have left the lock — or its reservation —
    // behind: the very next caller (once the foreign hold goes) has to work,
    // and `db` has exactly one connection to give.
    expect(await isHeld(slug)).toBe(true); // still the foreign session's
  });

  test("releases the lock when the critical section throws", async () => {
    const slug = `throws-${process.pid}`;
    await expect(lock(slug, () => Promise.reject(new Error("deploy blew up")))).rejects.toThrow(
      "deploy blew up",
    );
    // The `finally` unlocked before returning the reservation.
    expect(await isHeld(slug)).toBe(false);
    // And the slug is immediately usable again.
    await expect(lock(slug, () => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  test("releases the lock on the happy path too", async () => {
    const slug = `happy-${process.pid}`;
    await expect(lock(slug, () => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(await isHeld(slug)).toBe(false);
  });

  test("returning a reservation to the pool does NOT release the lock", async () => {
    // The claim this module originally got backwards. postgres.js `release()`
    // hands the connection back with its SESSION STATE intact, so an advisory
    // lock survives it — which is why the explicit `pg_advisory_unlock` is the
    // real release path, and why a FAILED unlock is logged rather than
    // swallowed. Taken by hand, because what this proves is that the lock's
    // own `finally` is load-bearing.
    const slug = `pool-return-${process.pid}`;
    const solo = createPostgresDb({ url, max: 1 });
    try {
      const reserved = await solo.reserve();
      await reserved.query(ACQUIRE, [SLUG_LOCK_NAMESPACE, slug]);
      reserved.release();

      // Still held — by an idle POOLED connection nobody is tracking.
      expect(await isHeld(slug)).toBe(true);

      // Only an explicit unlock on that same session clears it. (max:1 is what
      // guarantees we get the same connection back, which is also the hazard.)
      const again = await solo.reserve();
      await again.query(UNLOCK, [SLUG_LOCK_NAMESPACE, slug]);
      again.release();
      expect(await isHeld(slug)).toBe(false);
    } finally {
      await solo.close();
    }
  });

  test("a killed session releases the lock — the crashed-replica backstop", async () => {
    // This is what made the lease table and its pg_cron sweep deletable: a
    // replica that dies mid-deploy frees its slug immediately, with no expiry
    // to wait out.
    //
    // The session is killed with `pg_terminate_backend`, not by closing the
    // pool: `sql.end()` is an ORDERLY shutdown that waits for outstanding
    // reservations, so it models a clean exit (and, with a reservation still
    // out, just hangs — which is how the first draft of this test failed).
    // Terminating the backend is what a crashed process really looks like from
    // Postgres's side.
    const slug = `crash-${process.pid}`;
    const dying = createPostgresDb({ url, max: 1 });
    let reserved: ReservedDb | undefined;
    try {
      reserved = await dying.reserve();
      await reserved.query(ACQUIRE, [SLUG_LOCK_NAMESPACE, slug]);
      const pid = Number(
        (await reserved.query<{ pid: number }>("select pg_backend_pid() as pid"))[0]?.pid,
      );
      expect(await isHeld(slug)).toBe(true);

      await other.query("select pg_terminate_backend($1::int)", [pid]);
      // Lock release is part of backend teardown, so it is prompt but not
      // synchronous with the terminate returning.
      await vi.waitFor(async () => expect(await isHeld(slug)).toBe(false));

      // A survivor can take the slug straight away — no lease to outlast.
      await expect(lock(slug, () => Promise.resolve("recovered"))).resolves.toBe("recovered");
    } finally {
      // Hand the reservation back BEFORE closing, even though its backend is
      // gone. `close()` is the orderly shutdown this test's own prose warns
      // about: with a reservation still out it waits for it, and whether that
      // wait ever ends depends on the pool having already noticed the socket
      // die — a race the terminate above is what starts. Measured on a real
      // cluster: ~1 run in 8 hung here for the FULL test timeout with the body
      // already finished (every assertion passed, `closing` logged, `closed`
      // never), and CI lost all three attempts. A `.catch()` does not cover a
      // hang, and the retry that "fixed" it locally was the second attempt
      // finding the connection already dead.
      reserved?.release();
      // The pool's one connection is dead; tearing it down may reject.
      await dying.close().catch(() => undefined);
    }
  });

  test("a hold on a different slug does not block this one", async () => {
    // `hashtext` collisions are accepted (they cost two unrelated mutations
    // some contention and nothing else), but the common case must run in
    // parallel — otherwise every deploy queues behind every other.
    await holdElsewhere(`slug-one-${process.pid}`);
    await expect(lock(`slug-two-${process.pid}`, () => Promise.resolve("through"))).resolves.toBe(
      "through",
    );
  });
});
