// Copyright 2026 the AAI authors. MIT license.
/**
 * How an app database is ADDRESSED: which host, which database, whose credentials.
 *
 * Split out of `app-database.ts` when it went over the file-length cap, and it is
 * the right seam — provisioning decides what EXISTS, this decides how a caller
 * reaches it, and nothing here touches Postgres. Three callers need it and each
 * wants a different combination: the guest gets the tenant's own credentials
 * (`DATABASE_URL`), the platform gets admin credentials into the same database
 * (the wake sweep, the usage read), and provisioning gets admin credentials before
 * the tenant's role can connect at all.
 *
 * Two rules live here because they are properties of the URL rather than of the
 * database: the pooler's tenant SUFFIX on the username, and the fact that every
 * app-database connection is pooled in SESSION mode. Both are argued on the
 * functions themselves.
 */

import type { AppDbMeta } from "./app-database.ts";

/** Swap database/user/password into a cluster's admin URL. */
export function withDatabase(
  base: string,
  database: string,
  user?: string,
  password?: string,
): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    // Supabase's pooler (Supavisor) carries the tenant as a username suffix —
    // `postgres.<project-ref>` — and rejects a connection without it
    // ("(ENOIDENTIFIER) no tenant identifier provided"): the hostname is shared
    // across projects, so SNI cannot identify the tenant and the username is the
    // only channel. Carry the admin's suffix onto whatever role we name.
    const adminUser = decodeURIComponent(url.username);
    const suffix = adminUser.includes(".") ? adminUser.slice(adminUser.indexOf(".")) : "";
    url.username = encodeURIComponent(user + suffix);
  }
  if (password !== undefined) url.password = encodeURIComponent(password);
  return url.toString();
}

/**
 * Move a URL's host/port onto the POOLER's, keeping everything else.
 *
 * **Every app-database connection is POOLED, and what that buys is the pooler's
 * limits — NOT an exemption from the budget.** Session mode holds one server
 * connection per client connection, so an app's connections are real backends on
 * the instance and `APP_DB_CONNECTION_ALLOWANCE` is what counts them. This
 * paragraph used to claim the routing "takes them out of that budget", which is
 * the premise `MAX_PLATFORM_DB_CONNECTIONS` was corrected for: believing it once
 * made `platformDbBudget()` add the app databases twice and warn on every boot.
 * What the pooler really gives is a per-tenant bound (a pool per
 * `user+db+mode` triple, `max_pools` per tenant) in front of a shared instance.
 *
 * **The pooler is per CLUSTER.** `poolerUrl` arrives from the target the app's
 * own locator names, never from one fleet-wide value — a placement cluster is a
 * separate Supabase project with its own Supavisor and its own tenant ref, and
 * addressing an app at the wrong one fails every connection. See
 * `AppDbTarget.poolerUrl`.
 *
 * **Session mode (5432), NEVER transaction mode (6543).** Transaction mode breaks
 * the Workflow DevKit two independent ways: graphile-worker uses NAMED prepared
 * statements on its hot path (`get_job/graphile_worker`) which transaction mode
 * does not support, and `@workflow/world-postgres` opens its own `LISTEN` client
 * with no polling fallback — `readFromStream` does one catch-up SELECT and then
 * relies entirely on notifications, so live progress stalls silently. That
 * subscription is also a floating promise, so a `LISTEN` that ERRORS is an
 * unhandled rejection at world creation rather than a degrade.
 *
 * Unset leaves the URL alone, which means a DIRECT connection — correct for local
 * dev and for a plain Postgres, and understated by the budget, so boot announces
 * it (see `service-config.ts`).
 */
function withPoolerHost(url: string, poolerUrl: string | undefined): string {
  if (poolerUrl === undefined) return url;
  const target = new URL(url);
  const pooler = new URL(poolerUrl);
  target.host = pooler.host;
  return target.toString();
}

/**
 * The connection URL for one provisioned app: the app's OWN database and its own
 * role's credentials, on the pooler when one is configured.
 * `statement_timeout` on the role bounds runaway SQL; the database itself is the
 * isolation.
 */
export function appDbConnectionUrl(meta: AppDbMeta, adminUrl: string, poolerUrl?: string): string {
  return withPoolerHost(withDatabase(adminUrl, meta.role, meta.role, meta.password), poolerUrl);
}

export function appDbUrlFor(meta: AppDbMeta, fallbackAdminUrl: string, poolerUrl?: string): string {
  // The stored locator wins; rows predating it live on the primary cluster.
  return appDbConnectionUrl(meta, meta.url ?? fallbackAdminUrl, poolerUrl);
}

/**
 * The ADMIN connection URL for one app's database — the platform's own way in.
 *
 * Pooled for the same reason the tenant's is, and through the SAME cluster's
 * pooler: these are what the wake sweep and the usage read open, and a sweep
 * that reached an app on an extra cluster through the primary's Supavisor would
 * report every such app as unreadable.
 */
export function appDbAdminUrl(
  meta: AppDbMeta,
  fallbackAdminUrl: string,
  poolerUrl?: string,
): string {
  return withPoolerHost(withDatabase(meta.url ?? fallbackAdminUrl, meta.role), poolerUrl);
}
