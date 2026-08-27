// Copyright 2026 the AAI authors. MIT license.
/**
 * What an app database is ENTITLED to, and what that entitlement costs the fleet.
 *
 * Split out of `constants.ts` (which went over the line cap, and where this is
 * one concern among a dozen unrelated ones) and out of `app-database.ts` (the
 * DDL that applies it) for the same reason `app-db-url.ts` and
 * `app-db-session-tables.ts` were. What is here is the whole tier concern: the
 * closed set, the limit each tier carries, the arithmetic those limits divide,
 * and the one statement that moves a live role between them.
 *
 * Read `platform-db-budget.test.ts` for how these terms are held against
 * `MAX_PLATFORM_DB_CONNECTIONS` and against the guest-side sums in
 * `aai/sdk/app-db-budget.ts`, which are what the limits have to cover.
 *
 * @module
 */

import { appDbIdentifier, assertIdentifier } from "./app-db-identifier.ts";
import { APP_DB_TARGET_POOL_MAX, MAX_ACTIVE_APP_DATABASES } from "./constants.ts";
import { createLogger } from "./logger.ts";
import type { SqlExec } from "./secret-store.ts";

const log = createLogger("app-db.tier");

/**
 * What an app database is provisioned FOR — the thing its connection entitlement
 * is a function of.
 *
 * **Declared by the owner, because nothing here can derive it.** The platform
 * stores no agent config (that guide section is the whole argument, and the
 * `config` column was dropped in `20260810030000_drop_agents_config.sql`), so a
 * deploy cannot see whether a bundle declares workflows. Nor can it be observed:
 * the platform learns an app runs workflows by finding its wake-hint table, and
 * that table does not exist until the world has already started — which needs
 * the workflow tier's connections. Every automatic scheme deadlocks on that
 * ordering in one direction or the other, so the tier arrives with the request
 * that provisions the database and `POST /:slug/storage` carries it.
 *
 * It is a self-limiting claim, which is what makes a tenant-supplied value safe
 * here: the tiers are a closed set and the widest of them is what EVERY app used
 * to get, so the worst a caller can do by asking is ask for today's behaviour.
 */
export type AppDbTier = "storage" | "workflow";

/**
 * The tier every app used to be provisioned at, and still the default.
 *
 * A default of `workflow` cannot break an app; a default of `storage` would
 * break exactly the apps that matter most (a durable run failing to start is the
 * failure this repo has already paid for once — see `APP_DB_BOOT_SPARE`). So the
 * saving is opt-IN, and the caller that opts in is the one holding the config.
 */
export const DEFAULT_APP_DB_TIER: AppDbTier = "workflow";

/**
 * The per-tenant connection ceiling for an app that runs durable workflows, so
 * one hot app cannot starve the shared instance. It lives here rather than beside
 * the DDL that applies it because it is a TERM IN THE BUDGET (see
 * MAX_ACTIVE_APP_DATABASES), and the budget's arithmetic is checked by a unit
 * test that must not import a composition root to reach it.
 *
 * **10, and the number is a SUM a workflow guest really needs**, not a round
 * figure. It was 4, sized when `ctx.db` was the only thing that ever used the
 * role — true only because the Workflow DevKit could not connect at all under
 * the per-schema model. At 4 the symptom was every workflow request failing
 * `too many connections for role "app_…"`.
 *
 * **The terms live in the SDK, not here**: `guestAppDbConnections()`
 * (`aai/sdk/app-db-budget.ts`) is the table, because the SDK SETS every one of
 * them and this file only has to cover their sum, which
 * `platform-db-budget.test.ts` asserts. The table used to be COPIED here and
 * went stale the way a hand-kept copy does — four consumers counted while a real
 * guest had six of them, a ceiling of 13 — so the error above was
 * reported by whichever consumer asked last, in the wild the wake hint on a
 * guest that had booted beside a draining sibling.
 */
export const APP_DB_WORKFLOW_CONNECTION_LIMIT = 10;

/**
 * The same ceiling for an app that declares NO durable workflows.
 *
 * **Four, and seven of the workflow tier's ten were unspendable.** A guest that
 * declares no workflows never starts the world — `startWorkflowWorldIfDeclared`
 * returns on `!hasWorkflows` — so the DevKit's pool, its streamer's `LISTEN`
 * client and the queue-lock sweep's presence connection are never opened.
 * `storageAppDbConnections()` is what is left ({@link APP_DB_POOL_MAX}, the one
 * handle `ctx.db`, session state and uploads are leased off), and the spare rides
 * on top for the same two reasons it does at the other tier: the handover
 * overlap, and a boot beside a draining sibling.
 *
 * **What this buys is BLAST RADIUS and honest arithmetic — not steady-state
 * capacity, and conflating the two is easy.** A `connection limit` is a REFUSAL
 * threshold, not a reservation: Postgres holds no slots for it, and a voice
 * agent between calls holds close to zero connections either way (its pool opens
 * lazily and returns idle members after `POOL_IDLE_TIMEOUT_SECONDS`). So moving
 * such an app from 10 to 4 does not free a single live connection. What it does:
 * a runaway or buggy tenant can now take 4 rather than 10, and
 * {@link APP_DB_CONNECTION_ALLOWANCE}'s worst case — every active app at its
 * ceiling at once — fits five of these where it fits
 * {@link MAX_ACTIVE_APP_DATABASES} workflow apps.
 *
 * The corollary matters more than the tier: nothing enforces either number.
 * `MAX_ACTIVE_APP_DATABASES` is consulted by a budget assertion and a boot log
 * line and by no admission control, so the real ceiling is crossed silently and
 * surfaces as `too many connections for role` inside one tenant's guest or
 * `remaining connection slots are reserved` on a platform read. Measuring live
 * per-role usage is the gap; this is the blast-radius half.
 */
export const APP_DB_STORAGE_CONNECTION_LIMIT = 4;

/** The `connection limit` an app database is provisioned with, by tier. */
export function appDbConnectionLimit(tier: AppDbTier): number {
  return tier === "workflow" ? APP_DB_WORKFLOW_CONNECTION_LIMIT : APP_DB_STORAGE_CONNECTION_LIMIT;
}

/**
 * Connections {@link MAX_PLATFORM_DB_CONNECTIONS} leaves for app databases on the
 * PRIMARY cluster, once the platform's own direct pools are paid for.
 *
 * Stated rather than left implicit because it is what the two tiers divide, and
 * the division is the whole point of having tiers: 28 buys two workflow apps or
 * SEVEN storage-only ones. `platform-db-budget.test.ts` asserts it against the
 * same arithmetic the boot check prints, so this cannot drift from either.
 *
 * **HAND-SET, and the arithmetic is `MAX_PLATFORM_DB_CONNECTIONS` (40) minus the
 * fleet's own claim (`MAX_CONTAINERS` 3 x `SLUG_LOCK_POOL_MAX` 4 = 12).** Derived
 * instead, the budget test's central assertion would be a tautology — it would
 * compare the budget against a number defined as the budget minus something. Two
 * hand-set numbers with a test between them is what makes raising `MAX_CONTAINERS`
 * back to 5 a RED SUITE (20 + 28 = 48 > 40) rather than a silent overrun, which
 * is exactly the coupling `modal_deploy.py`'s own comment asks for.
 *
 * It was 20, against `MAX_CONTAINERS = 5`. Lowering that to 3 was measured — one
 * replica's broker holds 23k rps at p99 22ms — and the 8 connections it gave back
 * are here, moved off a term that does not grow with tenants and onto the one
 * that does. The total claim did not change, so this bought tenants and NOT
 * margin: 40 plus Supabase's own ~17 workers is still 57 of this instance's 60.
 */
export const APP_DB_CONNECTION_ALLOWANCE = 28;

/**
 * DIRECT connections one replica may open against ONE extra placement cluster,
 * charged to that cluster rather than to the primary.
 *
 * A separate function rather than a term in the sum above, because it is a claim
 * about a different instance — see that function's doc for the accounting error
 * this replaced. An extra cluster hosts app databases and nothing else: no slug
 * lock (mutation exclusion is fleet-wide and lives on the primary), no Vault, no
 * agents rows. So its own ceiling is this pool times `MAX_CONTAINERS`, plus the
 * entitlements of the apps placed on it — the same shape as the primary's
 * budget, one term shorter.
 */
export function appDbClusterConnectionsPerReplica(): number {
  return APP_DB_TARGET_POOL_MAX;
}

/** Is `value` one of the declared tiers? Guards a stored meta's `tier`. */
export function isAppDbTier(value: unknown): value is AppDbTier {
  return value === "storage" || value === "workflow";
}

/**
 * Move an already-provisioned role onto `tier`'s `connection limit`, reporting
 * whether anything changed.
 *
 * **The one mutation on a live app database that does NOT rotate its
 * credential**, which is what makes it callable on the idempotent path. A
 * re-provision mints a fresh password and the resident guest is still holding
 * the `DATABASE_URL` baked in at spawn (`storage-handler.ts`'s module doc has
 * what that cost), so raising a limit could not ride on one. `alter role …
 * connection limit` touches neither password nor login, and Postgres applies it
 * to connections made AFTER it — an app at its old ceiling keeps the connections
 * it already has.
 *
 * Read-then-write rather than an unconditional `alter`: the answer is what
 * decides whether the caller bumps the agents row, and a no-op bump rebuilds a
 * sandbox for nothing.
 *
 * Role attributes are CLUSTER-level, not database-level, so this runs on the
 * admin executor of the cluster the app's locator names — never on a recomputed
 * placement, the same rule `deprovision` states.
 */
export async function reconcileAppDbConnectionLimit(
  sql: SqlExec,
  slug: string,
  tier: AppDbTier,
): Promise<{ changed: boolean; limit: number }> {
  const id = assertIdentifier(appDbIdentifier(slug));
  const limit = appDbConnectionLimit(tier);
  const rows = await sql("select rolconnlimit from pg_roles where rolname = $1", [id]);
  const current = rows[0]?.rolconnlimit;
  // A role the catalog does not list is not this function's failure to report:
  // the caller holds a stored credential for it, so a missing role is a
  // half-deprovisioned app and `provision` is what repairs that.
  if (typeof current !== "number") return { changed: false, limit };
  if (current === limit) return { changed: false, limit };
  await sql(`alter role "${id}" connection limit ${limit}`);
  log.info("connection limit reconciled", { id, from: current, to: limit, tier });
  return { changed: true, limit };
}
