// Copyright 2026 the AAI authors. MIT license.
/**
 * Boot-time check that the instance can actually give what
 * {@link MAX_PLATFORM_DB_CONNECTIONS} promises.
 *
 * That constant is a CLAIM about provisioned hardware — `MAX_CONTAINERS` times
 * the per-replica pools, plus the app databases, against a number nobody in the
 * process had ever read. Its own doc used to say "nothing in the repo can check
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

import {
  APP_DB_CONNECTION_LIMIT,
  MAX_ACTIVE_APP_DATABASES,
  MAX_PLATFORM_DB_CONNECTIONS,
} from "./constants.ts";
import type { SqlExec } from "./secret-store.ts";

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
  /** What the platform's own budget claims, app databases included. */
  budgeted: number;
  /** `maxConnections - inUse - budgeted`. Negative means the claim cannot hold. */
  headroom: number;
};

/**
 * The platform's total claim on the instance: its own direct pools plus the app
 * databases those pools cannot reach.
 *
 * App databases are IN this sum, which is the correction. They were excluded as
 * "pooled", but the pooler is Supavisor in SESSION mode — mandatory for the
 * Workflow DevKit, and multiplexing nothing — so each is a real backend. See
 * {@link MAX_ACTIVE_APP_DATABASES}.
 *
 * **They are in it ONCE, which is the fix.** This used to return
 * `MAX_PLATFORM_DB_CONNECTIONS + MAX_ACTIVE_APP_DATABASES * APP_DB_CONNECTION_LIMIT`
 * — adding the app databases to a constant that already contains them, since
 * `platform-db-budget.test.ts` asserts `fleetDirect + appTotal <=
 * MAX_PLATFORM_DB_CONNECTIONS` and `MAX_ACTIVE_APP_DATABASES`'s own doc reads 40
 * as "the platform's own direct pools take 20 of the 40, which leaves room for
 * two apps at their entitlement". So the claim came out 20 over: 60 against a
 * provisioned `max_connections` of 60, which made the overrun warning fire on
 * EVERY boot (7 of 7 in one production day) and therefore say nothing. A warning
 * that cannot be cleared is not a warning, and this one guards a control-plane
 * outage.
 *
 * The double count was invisible because both halves read correctly on their own
 * — the sum is only wrong in relation to what the constant already means. Which
 * is why the arithmetic now lives in ONE place and both readers come here: the
 * test asserts this function against the constant, so the two cannot drift back
 * apart.
 */
export function platformDbBudget(): number {
  // Deliberately the constant itself, not a sum. `MAX_PLATFORM_DB_CONNECTIONS`
  // IS the total — `MAX_CONTAINERS x platformDbConnectionsPerReplica()` for the
  // direct pools PLUS `MAX_ACTIVE_APP_DATABASES x APP_DB_CONNECTION_LIMIT` for
  // the app databases — and `platform-db-budget.test.ts` is what holds it to
  // that. Re-deriving the sum here is what produced the double count.
  return MAX_PLATFORM_DB_CONNECTIONS;
}

/** Read the instance's capacity and compare it against what we claim. */
export async function readPlatformDbCapacity(sql: SqlExec): Promise<PlatformDbCapacity> {
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
  const budgeted = platformDbBudget();
  return { maxConnections, inUse, budgeted, headroom: maxConnections - inUse - budgeted };
}

/**
 * Announce the instance's capacity, and warn when the budget overruns it.
 *
 * Sync, fire-and-forget with a `.catch` — the same shape as
 * `bootstrapPlatformDb`, and for the same reason: boot must not wait on it, and
 * a failed reading is worth a line rather than a refusal to serve.
 */
export function announcePlatformDbCapacity(sql: SqlExec): void {
  readPlatformDbCapacity(sql)
    .then((c) => {
      // The split is quoted INSIDE the total rather than added to it, because
      // adding it is the bug this line used to print: "platform budget=60
      // (40 direct + 2 app databases x 10)" both overstated the claim by 20 and
      // read as though 60 were the sum of 40 and 20. See `platformDbBudget`.
      const appTotal = MAX_ACTIVE_APP_DATABASES * APP_DB_CONNECTION_LIMIT;
      const arithmetic =
        `max_connections=${c.maxConnections}, in use at boot=${c.inUse}, ` +
        `platform budget=${c.budgeted} (of which ${MAX_ACTIVE_APP_DATABASES} app ` +
        `databases x ${APP_DB_CONNECTION_LIMIT} = ${appTotal})`;
      if (c.headroom < 0) {
        console.warn(
          `Platform database budget OVERRUNS the instance by ${-c.headroom} connections: ` +
            `${arithmetic}. At peak this surfaces as every platform read failing at once ` +
            '("remaining connection slots are reserved"), not as degradation. Lower ' +
            "MAX_CONTAINERS or MAX_ACTIVE_APP_DATABASES, or provision a larger instance.",
        );
        return;
      }
      console.info(`Platform database capacity ok — ${c.headroom} spare: ${arithmetic}`);
    })
    .catch((err: unknown) => {
      console.warn("Could not read the platform database's connection capacity:", err);
    });
}
