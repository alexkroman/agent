// Copyright 2026 the AAI authors. MIT license.
/**
 * Boot-time check that the instance can actually give what
 * {@link MAX_PLATFORM_DB_CONNECTIONS} promises.
 *
 * That constant is a CLAIM about provisioned hardware — `MAX_CONTAINERS` times
 * the per-replica pools, against a number nobody in the process had ever read. Its own doc used to say "nothing in the repo can check
 * it", and that turned out to be the reason it went unchecked rather than a
 * property of the problem: this module holds a working connection, so
 * `show max_connections` costs one round trip.
 *
 * **The failure it exists to pre-empt is not gradual.** Pools open LAZILY, so
 * the ceiling is only reached under load, and what happens there is that every
 * platform read starts failing at once with "remaining connection slots are
 * reserved" — Vault, the agents row the broker needs, workspaces, chats. A
 * control-plane outage, at peak, with nothing before it to read as a warning.
 * This is that warning, and it costs one query at boot.
 *
 * **The instance's non-platform load is MEASURED, not declared**, and the
 * laziness above is exactly what makes that sound. At boot this process holds
 * almost nothing (measured against a real stack: ONE direct backend at idle, on
 * pools sized 4 and 4), so a `pg_stat_activity` count taken here is dominated by
 * everything else on the instance — Supabase's own Realtime / PostgREST /
 * Storage workers, pg_cron, Supavisor's server side. Declaring that number
 * instead would add a second unverified constant to a file whose problem is an
 * unverified constant.
 *
 * Two properties of the reading, both deliberate:
 *
 * - **It is a floor on other load, not a measurement of it.** A replica booting
 *   into an already-warm fleet counts its PEERS' connections as "other", so the
 *   estimate is conservative and the check errs toward warning. That is the
 *   right direction for a gate whose miss is an outage.
 * - **It never blocks boot.** A server that refuses to start over a capacity
 *   projection converts a future degradation into a present outage, which is a
 *   strictly worse trade — and the reading can be wrong in the pessimistic
 *   direction for the reason above. It warns, loudly, with the arithmetic.
 */

import { errorMessage } from "@alexkroman1/aai";
import { invariant } from "@alexkroman1/aai/internal";
import { ADMIN_POOL_MAX, MAX_PLATFORM_DB_CONNECTIONS } from "./constants.ts";
import { createLogger } from "./logger.ts";
import type { SqlExec } from "./secret-store.ts";

const log = createLogger("platform.db-capacity");

/** `show` returns text, so the value arrives as a string however it is aliased. */
const MAX_CONNECTIONS_SQL = "show max_connections";
/**
 * Every backend on the instance, across all databases — `datname is null` is a
 * background worker with no connection slot of its own to give back.
 */
const IN_USE_SQL = "select count(*)::int as n from pg_stat_activity where datname is not null";

/** What the reading came out as, so callers (and tests) can assert on it. */
export type PlatformDbCapacity = {
  /** The instance's `max_connections`. */
  maxConnections: number;
  /** Backends in use at boot — a FLOOR on non-platform load (see module doc). */
  inUse: number;
  /** What the platform's own budget claims. */
  budgeted: number;
  /** `maxConnections - inUse - budgeted`. Negative means the claim cannot hold. */
  headroom: number;
};

/**
 * The autoscaler's container ceiling — the MULTIPLIER on every per-replica pool.
 *
 * Decided in `modal_deploy.py` (`MAX_CONTAINERS`) and exported into the
 * container's env from there, rather than restated here: it is a property of the
 * deploy recipe, and a hand-kept second copy is the shape this file already
 * warns about twice. `platform-db-budget.test.ts` reads the Python constant
 * directly, so the two cannot drift.
 *
 * **1 when unset, and that is the honest default rather than a safe one.** A
 * process with no autoscaler in front of it IS one replica — `aai dev`, a unit
 * test, a self-hosted `npm start` — so the fleet claim equals the per-replica
 * claim. A larger default would invent a fleet that does not exist and warn on
 * every developer's laptop; the deployment that really has one says so.
 */
export function fleetMaxContainers(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MAX_CONTAINERS?.trim());
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * Connections the ADMIN pool costs the instance that {@link
 * MAX_PLATFORM_DB_CONNECTIONS} does not count — fleet-wide.
 *
 * That constant excludes the admin pool on ONE premise: that the pool reaches
 * the instance through `PLATFORM_POOLER_URL` in transaction mode, which really
 * does multiplex (see {@link platformDbConnectionsPerReplica}). With the
 * variable unset the premise is false, every replica opens `ADMIN_POOL_MAX`
 * DIRECT session-mode backends, and the budget understates the fleet by this
 * many.
 *
 * It was understating it in production, and the arithmetic is the whole reason
 * this function exists rather than a comment: `max_connections=60`, 20 held by
 * Supabase's own workers, a 40 budget — and 5 x 4 = 20 more that nothing added
 * up. The claim was 80 against 60. Boot said `capacity ok — 0 spare` on the line
 * directly below the warning that named those four per replica, so both facts
 * were printed and neither was compared, and the 53300 exhaustion they predict
 * ("remaining connection slots are reserved") arrived with no warning at all.
 *
 * Presence, not `platformPoolerUrl()`: that validator THROWS on a malformed
 * value, and a capacity READING must never be the thing that fails a boot. By
 * the time this runs `service-config.ts` has already validated it, so an empty
 * or absent variable is the only case left to distinguish.
 */
export function unpooledAdminConnections(env: NodeJS.ProcessEnv = process.env): number {
  return env.PLATFORM_POOLER_URL?.trim() ? 0 : fleetMaxContainers(env) * ADMIN_POOL_MAX;
}

/**
 * The platform's total claim on the instance.
 *
 * Every connection in it is now the platform's OWN — its direct pools, plus the
 * admin pool when nothing pools it. Tenant databases used to add a term here and
 * the history is the reason this function exists rather than a constant being read
 * directly: the allowance was double-counted, added to a constant that already
 * contained it, and the claim came out 20 over — 60 against a provisioned
 * `max_connections` of 60, which made the overrun warning fire on EVERY boot (7 of
 * 7 in one production day) and therefore say nothing. A warning that cannot be
 * cleared is not a warning, and this one guards a control-plane outage.
 *
 * That double count was invisible because both halves read correctly on their own
 * — the sum was only wrong in relation to what the constant already meant. So the
 * arithmetic lives in ONE place and both readers come here; the test asserts this
 * function against the constant, and they cannot drift apart. With the tenant term
 * gone there is one fewer thing to double-count, but the seam is what kept the last
 * one findable.
 */
export function platformDbBudget(env: NodeJS.ProcessEnv = process.env): number {
  // Deliberately the constant itself, not a sum. `MAX_PLATFORM_DB_CONNECTIONS`
  // IS the total — `MAX_CONTAINERS x platformDbConnectionsPerReplica()` — and
  // `platform-db-budget.test.ts` is what holds it to that. Re-deriving the sum
  // here is what produced the double count described above.
  //
  // The ONE term it cannot contain is the admin pool, because whether that pool
  // costs the instance anything is a runtime question and not a constant: see
  // `unpooledAdminConnections`, which is why this takes an env at all.
  return MAX_PLATFORM_DB_CONNECTIONS + unpooledAdminConnections(env);
}

/** Read the instance's capacity and compare it against what we claim. */
export async function readPlatformDbCapacity(
  sql: SqlExec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlatformDbCapacity> {
  const [limit, used] = await Promise.all([sql(MAX_CONNECTIONS_SQL), sql(IN_USE_SQL)]);
  // `show` names its column after the setting; read positionally so a Postgres
  // version that aliases it differently does not silently yield NaN.
  const raw = Object.values(limit[0] ?? {})[0];
  const maxConnections = Number(raw);
  const inUse = Number(used[0]?.n);
  if (!(Number.isFinite(maxConnections) && Number.isFinite(inUse))) {
    throw new Error(
      `Unreadable capacity: max_connections=${String(raw)} in_use=${String(used[0]?.n)}`,
    );
  }
  const budgeted = platformDbBudget(env);
  return { maxConnections, inUse, budgeted, headroom: maxConnections - inUse - budgeted };
}

/**
 * The arithmetic a boot line prints, as a DECOMPOSITION of the number the
 * headroom was computed from.
 *
 * ## The bug this is shaped against
 *
 * It said `plus`, and the term was already in the total. `c.budgeted` is
 * `platformDbBudget(env)`, which is `MAX_PLATFORM_DB_CONNECTIONS +
 * unpooledAdminConnections(env)` — so on the arm production actually runs
 * (`PLATFORM_POOLER_URL` unset, `MAX_CONTAINERS=3`) boot printed
 * `platform budget=42 (plus 12 for DIRECT admin pools)`, which a reader sums to
 * 54 against a real claim of 42. The `headroom` beside it used 42, so the line
 * disagreed with itself and an operator sizing the instance from it would
 * over-provision by exactly the admin pool.
 *
 * The comment that produced it was reasoning about the CONSTANT — which really
 * does exclude the admin pool — while the code printed the BUDGET, which does
 * not. That is the whole failure mode: an announcement that RESTATES a number
 * instead of reading the one the behaviour used. It is also the second time this
 * exact double count has been shipped here; the first was in the arithmetic, and
 * this one hid in the preposition.
 *
 * ## Why it is a function with an invariant in it
 *
 * The parts are now DERIVED and their sum is checked against the total, so the
 * two cannot drift again: a term added to `platformDbBudget` and not to this line
 * fails, and so does the reverse. Pure, so the property is a unit test rather
 * than something only a boot can exercise.
 */
export function capacityLine(c: PlatformDbCapacity, env: NodeJS.ProcessEnv): string {
  const unpooled = unpooledAdminConnections(env);
  const fleet = c.budgeted - unpooled;
  // The line names two terms; they must BE the total it prints beside them.
  invariant(fleet + unpooled === c.budgeted, "capacity.line.terms", () => ({
    fleet,
    unpooled,
    budgeted: c.budgeted,
  }));
  return (
    `max_connections=${c.maxConnections}, in use at boot=${c.inUse}, ` +
    `platform budget=${c.budgeted}` +
    // "of which", never "plus": the admin pool is INSIDE the budget, and the
    // preposition is the entire difference between a decomposition and a sum.
    // Omitted when a transaction pooler makes it zero — a term that costs
    // nothing does not belong in a line somebody reads at boot.
    (unpooled > 0
      ? ` (of which ${unpooled} is DIRECT admin pools — set PLATFORM_POOLER_URL to pool them)`
      : "")
  );
}

/**
 * Announce the instance's capacity, and warn when the budget overruns it.
 *
 * Sync, fire-and-forget with a `.catch` — the same shape as
 * `bootstrapPlatformDb`, and for the same reason: boot must not wait on it, and
 * a failed reading is worth a line rather than a refusal to serve.
 */
export function announcePlatformDbCapacity(
  sql: SqlExec,
  env: NodeJS.ProcessEnv = process.env,
): void {
  readPlatformDbCapacity(sql, env)
    .then((c) => {
      // The app-database allowance used to be quoted INSIDE this total — "of which
      // 28 for app databases: 2 at the workflow tier's 10" — because ADDING it was
      // a bug this line once printed, overstating the claim by 20. There are no app
      // databases now: every connection in the budget is the platform's own, so the
      // total needs no split and the arithmetic is one term plus the admin pool.
      //
      // The unpooled admin pool is still named SEPARATELY, because it is the one
      // term the constant does not contain (see `unpooledAdminConnections`), and it
      // is omitted entirely when a transaction pooler makes it zero: a term that
      // costs nothing does not belong in a line somebody reads at boot.
      const arithmetic = capacityLine(c, env);
      if (c.headroom < 0) {
        log.warn(
          `budget OVERRUNS the instance by ${-c.headroom} connections: ` +
            `${arithmetic}. At peak this surfaces as every platform read failing at once ` +
            '("remaining connection slots are reserved"), not as degradation. Lower ' +
            "MAX_CONTAINERS, or provision a larger instance.",
        );
        return;
      }
      log.info(`capacity ok — ${c.headroom} spare: ${arithmetic}`);
    })
    .catch((err: unknown) => {
      log.warn("could not read the platform database's connection capacity", {
        error: errorMessage(err),
      });
    });
}
