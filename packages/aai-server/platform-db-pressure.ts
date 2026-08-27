// Copyright 2026 the AAI authors. MIT license.
/**
 * What the instance's connection slots are ACTUALLY being used for, on an
 * interval — the measurement the connection budget has always been missing.
 *
 * ## The gap this closes
 *
 * `platform-db-capacity.ts` reads `max_connections` and a `pg_stat_activity`
 * count ONCE, at boot, and compares them against `platformDbBudget()`. That
 * catches a budget which over-promises the instance, which is a provisioning
 * mistake. It cannot catch the thing that actually takes the platform down:
 * live usage growing into the ceiling hours or weeks after boot.
 *
 * And nothing else was watching. `MAX_ACTIVE_APP_DATABASES` — the term that
 * scales with tenants — is consulted by a unit test's arithmetic and by one boot
 * log line, and **by no admission control anywhere**: nothing refuses to
 * provision the Nth app database, nothing refuses to boot the Nth guest, and no
 * pool sheds load as the instance fills. So the ceiling is crossed SILENTLY, and
 * what an operator sees first is one of the two failures it produces, neither of
 * which names the cause:
 *
 * - `too many connections for role "app_…"` inside one tenant's guest, from
 *   whichever of its consumers asked last (in the wild: the wake hint on a guest
 *   that had booted beside a draining sibling), or
 * - `remaining connection slots are reserved for roles with the SUPERUSER
 *   attribute` on a PLATFORM read — Vault, the agents row the broker needs,
 *   workspaces — which is a control-plane outage at peak.
 *
 * Note the asymmetry: the first is one tenant's problem and the second is
 * everyone's, and which one arrives depends only on who asks last. That is why a
 * gauge is worth more here than a bigger number.
 *
 * ## Why this is a READING and not a limiter
 *
 * The same reason `announcePlatformDbCapacity` never blocks boot: refusing work
 * over a projection turns a future degradation into a present outage. Admission
 * control is a real design question — who gets refused, with what status, and
 * whether a tenant's guest or the control plane yields first — and it wants the
 * measurement to exist before anyone picks a policy. This is the measurement.
 *
 * ## Its own sweep, not a rider on the wake sweep
 *
 * The wake sweep already elects a leader every 60s and already holds a reserved
 * admin connection, so folding this reading into its pass would be strictly
 * cheaper — no second interval, no second lock, no second connection. It is
 * still wrong: `WORKFLOW_WAKE_INTERVAL_MS=0` is that sweep's documented kill
 * switch, and an operator who set it to stop booting sandboxes would silently
 * take the connection measurement down too. A measurement that disappears with
 * an unrelated feature flag is the "gate that checks nothing" shape this repo
 * keeps paying for. It also needs no `appDb`, so it runs on a composition that
 * has a platform database whether or not anything there uses workflows.
 *
 * ## Per ROLE, because a total cannot be acted on
 *
 * A fleet total says the instance is full; a per-role breakdown says which app
 * to look at, and whether the pressure is one tenant at its ceiling or fifty
 * behaving normally. Those call for opposite responses — the first is a bug or
 * an abuser, the second is provisioning — and the entitlement each role carries
 * (`rolconnlimit`, which is now tiered: see `app-db-tier.ts`) is what
 * distinguishes them.
 *
 * @module
 */

import { createIntervalSweep } from "./_interval-sweep.ts";
import { envMs } from "./constants.ts";
import { createLogger } from "./logger.ts";
import { platformDbBudget } from "./platform-db-capacity.ts";
import type { AdminDb } from "./platform-lock.ts";

// ── This concern's own numbers ───────────────────────────────────────────────
//
// Here rather than in `constants.ts`, which is at its line cap — the placement
// rule `WORKFLOW_WAKE_READ_CONCURRENCY` follows, and for the same reason: these
// three decide nothing outside this module, and the budget TERMS that other
// files share do live in `constants.ts`.

/**
 * How often one replica reads the instance's connection pressure
 * (`platform-db-pressure.ts`).
 *
 * Five minutes, and the interval is chosen against what an operator can DO with
 * the answer rather than against how fast the number moves. Connection pressure
 * builds over minutes to hours — a guest holds its pools for the life of a
 * session and self-exits five minutes after the last one — and the response to a
 * warning is provisioning or a tier change, neither of which is a
 * thirty-second decision. A tighter interval buys nothing and costs a reserved
 * admin connection plus three catalog queries every time.
 *
 * Override with `PLATFORM_DB_PRESSURE_INTERVAL_MS`; **0 disables the reading**,
 * which is the documented kill switch and is announced.
 */
export const PLATFORM_DB_PRESSURE_INTERVAL_MS = envMs(
  process.env.PLATFORM_DB_PRESSURE_INTERVAL_MS,
  300_000,
);

/**
 * The share of `max_connections` past which the pressure reading WARNS.
 *
 * 0.8, which leaves the fleet a replica's worth of pools to grow into before
 * platform reads start failing — the failure being `remaining connection slots
 * are reserved` on Vault and the agents row, i.e. a control-plane outage rather
 * than a degradation. Below this the reading is `debug`, deliberately: a warning
 * an operator cannot clear teaches them to filter the channel, and this channel
 * carries the one that matters.
 *
 * Note the OTHER trigger is not a fraction at all — a single app role at its own
 * `connection limit` warns regardless of instance headroom, because that tenant
 * is already being refused.
 */
export const PLATFORM_DB_PRESSURE_WARN_FRACTION = 0.8;

/**
 * Advisory-lock namespace for the pressure reading's leader election.
 *
 * Distinct from {@link SLUG_LOCK_NAMESPACE} and from the wake sweep's, for the
 * reason the wake sweep's own doc gives: a shared namespace makes two unrelated
 * operations serialize, and here it would read as "the reading never runs while
 * anything is deploying".
 */
export const PLATFORM_DB_PRESSURE_NAMESPACE = 0x41_41_49_03;
const log = createLogger("platform.db.pressure");

/**
 * One replica reads per tick.
 *
 * Same shape and the same reasoning as the wake sweep's election, and the same
 * proof: `pg_try_advisory_xact_lock` inside `begin … commit` is correct through a
 * TRANSACTION pooler too, because such a pooler pins one backend for exactly a
 * transaction's lifetime (`platformDbConnectionsPerReplica` carries the
 * measurement). Its own namespace, so a collision cannot make this look like
 * "the reading never runs while anything is deploying".
 */
const TRY_LOCK_SQL = "select pg_try_advisory_xact_lock($1::int, $2::int) as locked";
const PRESSURE_LOCK_KEY = 1;

const MAX_CONNECTIONS_SQL = "show max_connections";

/**
 * Backends per app role, with the entitlement each one carries.
 *
 * A REGEX on the identifier grammar rather than a `like 'app\\_%'`: `_` is a
 * LIKE wildcard, so the escaped form is one backslash away from matching
 * `appXsomething` and the escape is invisible in review. `appDbIdentifier`
 * produces `app_` plus 16 hex chars and `assertIdentifier` enforces it, so the
 * anchored pattern is exact.
 *
 * A LEFT JOIN from `pg_roles`, not from `pg_stat_activity`: a provisioned role
 * with zero live backends is a row worth having (it is what makes "how many apps
 * are actually active" answerable), and an inner join would drop exactly those.
 * Idle backends COUNT — an idle connection holds its slot.
 */
const APP_ROLE_PRESSURE_SQL = `select r.rolname as role,
       r.rolconnlimit::int as limit,
       count(a.pid)::int as in_use
from pg_roles r
left join pg_stat_activity a on a.usename = r.rolname
where r.rolname ~ '^app_[0-9a-f]{16}$'
group by r.rolname, r.rolconnlimit
order by count(a.pid) desc, r.rolname`;

/** Total backends on the instance, whoever owns them. */
const IN_USE_SQL = "select count(*)::int as n from pg_stat_activity where datname is not null";

/** One app role's live usage against what it is entitled to. */
export type AppRolePressure = {
  role: string;
  /** Live backends, idle ones included. */
  inUse: number;
  /** The role's `connection limit`; `-1` is Postgres for "no limit". */
  limit: number;
};

/** A reading of where the instance's connection slots have gone. */
export type PlatformDbPressure = {
  maxConnections: number;
  /** Backends in use across the whole instance, ours and Supabase's alike. */
  inUse: number;
  /** What this fleet claims it may consume — `platformDbBudget()`. */
  budgeted: number;
  /** Per app role, busiest first. Includes roles with no live backend. */
  roles: AppRolePressure[];
};

/**
 * Read the instance's pressure. Three short queries on one connection.
 *
 * Throws on an unreadable answer rather than reporting a plausible zero: a
 * reading that silently becomes `0/0` is the failure mode this whole module
 * exists to replace, and the caller logs the throw.
 */
export async function readPlatformDbPressure(
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlatformDbPressure> {
  const [limitRows, usedRows, roleRows] = await Promise.all([
    query(MAX_CONNECTIONS_SQL),
    query<{ n: number }>(IN_USE_SQL),
    query<{ role: string; limit: number; in_use: number }>(APP_ROLE_PRESSURE_SQL),
  ]);
  // `show` names its column after the setting, so read positionally — a Postgres
  // version that aliases it differently must not silently yield NaN.
  const raw = Object.values(limitRows[0] ?? {})[0];
  const maxConnections = countOf(raw);
  const inUse = countOf(usedRows[0]?.n);
  if (maxConnections === undefined || inUse === undefined) {
    throw new Error(
      `Unreadable pressure: max_connections=${String(raw)} in_use=${String(usedRows[0]?.n)}`,
    );
  }
  return {
    maxConnections,
    inUse,
    budgeted: platformDbBudget(env),
    roles: roleRows.map((r) => ({ role: r.role, inUse: r.in_use, limit: r.limit })),
  };
}

/**
 * A count out of a driver row, or `undefined` if the value is not one.
 *
 * The `typeof` gate is the whole point and a bare `Number()` is the trap: it
 * coerces `null` to **0**, and `[]` and `""` to 0 as well, so a column the driver
 * hands back as null reads as a perfectly plausible "nothing is connected" —
 * which is exactly the silent zero this module exists to replace. Not reachable
 * from `count(*)`, which never returns null, and entirely reachable from the
 * `show` above, where the value is whatever the setting parsed to.
 */
function countOf(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Roles at or over their own entitlement — the ones already being refused. */
export function rolesAtLimit(pressure: PlatformDbPressure): AppRolePressure[] {
  // `-1` means Postgres imposes no limit on the role, so it can never be "at"
  // one. Provisioning always sets a limit, so a `-1` here is an app whose role
  // predates that or was altered by hand — worth not misreporting as saturated.
  return pressure.roles.filter((r) => r.limit > 0 && r.inUse >= r.limit);
}

/**
 * Announce a reading, and WARN only when something is actionable.
 *
 * Two independent triggers, because they call for different responses:
 * instance-level saturation is provisioning, and a single role at its ceiling is
 * that app's bug or its tier. A reading with neither is `debug` — a line every
 * tick at `info` is how an operator learns to filter this channel out, and this
 * is the channel that would carry the one that matters.
 */
export function announcePlatformDbPressure(pressure: PlatformDbPressure): void {
  const used = pressure.inUse / (pressure.maxConnections || 1);
  const saturated = used >= PLATFORM_DB_PRESSURE_WARN_FRACTION;
  const atLimit = rolesAtLimit(pressure);
  const active = pressure.roles.filter((r) => r.inUse > 0);
  // The busiest few, never every role: a fleet of hundreds would put a
  // kilobyte of names in a line nobody finishes reading.
  const busiest = active
    .slice(0, 3)
    .map((r) => `${r.role}=${r.inUse}/${r.limit}`)
    .join(" ");
  const summary =
    `max_connections=${pressure.maxConnections} in use=${pressure.inUse} ` +
    `(${Math.round(used * 100)}%) fleet claim=${pressure.budgeted}, ` +
    `${active.length} of ${pressure.roles.length} app role(s) connected` +
    (busiest ? `: ${busiest}` : "");

  if (atLimit.length > 0) {
    log.warn(
      "app role(s) AT their connection limit — further connections are being REFUSED " +
        `(\`too many connections for role\`): ${atLimit
          .map((r) => `${r.role}=${r.inUse}/${r.limit}`)
          .join(" ")}. Raise the app's tier (\`aai storage enable --tier workflow\`) ` +
        `or find what is holding them. ${summary}`,
    );
    return;
  }
  if (saturated) {
    log.warn(
      `platform database is ${Math.round(used * 100)}% of max_connections — past ` +
        `${Math.round(PLATFORM_DB_PRESSURE_WARN_FRACTION * 100)}%, platform reads start ` +
        "failing with `remaining connection slots are reserved` (a control-plane " +
        `outage) before any tenant notices. ${summary}`,
    );
    return;
  }
  log.debug(`platform database pressure: ${summary}`);
}

/** Start the pressure reading. Returns its stop. */
export function startPlatformDbPressureSweep(opts: {
  adminDb?: AdminDb | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  intervalMs?: number | undefined;
}): () => void {
  const env = opts.env ?? process.env;
  const intervalMs = opts.intervalMs ?? PLATFORM_DB_PRESSURE_INTERVAL_MS;
  const adminDb = opts.adminDb;
  if (!adminDb) {
    // Not a warning: a composition with no platform database has no instance to
    // measure, which is the ordinary shape of `aai dev` and every unit test.
    log.debug("pressure sweep not started: no platform database");
    return () => undefined;
  }
  if (intervalMs <= 0) {
    // `info`, like the wake sweep's kill switch: an operator who set this is
    // reading the log to confirm it took.
    log.info("pressure sweep not started: interval is 0");
    return () => undefined;
  }
  const sweep = createIntervalSweep(async () => {
    const reserved = await adminDb.reserve();
    try {
      const lock = await reserved.query<{ locked: boolean }>(TRY_LOCK_SQL, [
        PLATFORM_DB_PRESSURE_NAMESPACE,
        PRESSURE_LOCK_KEY,
      ]);
      // Another replica has this tick. A lost lock is a silent skip, not an
      // error: the reading is fleet-wide, so one replica taking it is the whole
      // answer and five taking it would be five identical lines.
      if (lock[0]?.locked !== true) return;
      announcePlatformDbPressure(await readPlatformDbPressure(reserved.query, env));
    } catch (err) {
      // Reported and swallowed. A reading that cannot be taken must never be the
      // reason a replica dies, and the driver's own failure is already mapped to
      // a 503 on the request paths that matter.
      log.warn("pressure reading failed", { error: String(err) });
    } finally {
      reserved.release();
    }
  });
  log.info(`reading platform database pressure every ${intervalMs}ms`);
  return sweep.start(intervalMs);
}
