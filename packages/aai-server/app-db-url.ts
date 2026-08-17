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
 * **Every app-database connection is POOLED, and the direct-connection budget
 * depends on it.** `MAX_PLATFORM_DB_CONNECTIONS` counts DIRECT session-mode
 * connections, which consume the instance's `max_connections` outright with
 * nothing multiplexing them — and per-app databases would otherwise add a
 * connection per app to that count, which is the one variable a fleet-wide
 * ceiling cannot bound. Routing them through Supavisor takes them out of that
 * budget and puts them under the pooler's own limits instead.
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
 * Pooled for the same reason the tenant's is: these are what the wake sweep and
 * the usage read open, and they are exactly the per-app connections the direct
 * budget cannot account for.
 */
export function appDbAdminUrl(
  meta: AppDbMeta,
  fallbackAdminUrl: string,
  poolerUrl?: string,
): string {
  return withPoolerHost(withDatabase(meta.url ?? fallbackAdminUrl, meta.role), poolerUrl);
}
