// Copyright 2026 the AAI authors. MIT license.
/**
 * WHICH Postgres connection the platform opens for what, and in which mode.
 *
 * Split out of `service-config.ts` (which was over the file-length cap) along a
 * real seam rather than an arbitrary one: these three resolvers answer one
 * question — may this connection be POOLED, and how — and the answer is measured
 * rather than chosen. `supabase/config.toml`'s pooler stanza carries the run:
 *
 * - `SUPABASE_DB_URL` stays DIRECT, because the slug lock is a session-scoped
 *   `pg_advisory_lock` and a rival connection acquired the same lock through a
 *   transaction pooler. That is the silent loss of mutual exclusion
 *   `assertSessionModeUrl` exists to prevent, and it had never been reproduced
 *   before.
 * - The ADMIN pool may be TRANSACTION-pooled: the only lock on it is
 *   `pg_try_advisory_xact_lock` inside `begin … commit`, whose lifetime is
 *   exactly the transaction a pooler pins a backend for — verified correct
 *   including a rival refused while held and release on commit.
 * - App databases must be SESSION-pooled, because they host the Workflow DevKit:
 *   graphile-worker uses NAMED prepared statements, `world-postgres` opens a
 *   `LISTEN` client with no polling fallback, and `workflow-lock-sweep.ts` takes
 *   a session-scoped advisory lock. Transaction mode breaks all three, silently.
 *
 * `platform-connection-config.test.ts` pins every rule here, including the two
 * refusals that read backwards until you see what they prevent.
 */

import { assertSessionModeUrl, isTransactionModePooler } from "./platform-lock.ts";

/**
 * Supavisor's TRANSACTION-mode URL for the platform ADMIN pool, or `undefined`.
 *
 * The opposite mode from {@link appDbPoolerUrl}, and both are forced. Transaction
 * mode is what actually multiplexes — a session-mode pool holds one server
 * connection per client connection for its lifetime and would save nothing — and
 * the admin pool is the one that may use it, because the only lock on it is
 * `pg_try_advisory_xact_lock` inside `begin … commit`, whose lifetime is exactly
 * the transaction a pooler pins a backend for.
 *
 * REFUSES a session-mode URL, which reads backwards until you see what it
 * prevents: a session-mode URL here is silently useless (no multiplexing) while
 * looking configured, so the budget would count on a saving that is not
 * happening. The SLUG-LOCK pool keeps the direct URL regardless — see
 * `platformDbConnectionsPerReplica`.
 */
export function platformPoolerUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.PLATFORM_POOLER_URL?.trim();
  if (!raw) return undefined;
  if (!isTransactionModePooler(new URL(raw))) {
    throw new Error(
      "PLATFORM_POOLER_URL must name a TRANSACTION-mode pooler (port 6543 / pgbouncer=true). " +
        "A session-mode pooler holds one server connection per client connection, so it " +
        "multiplexes nothing while making the connection budget claim it does. Leave it " +
        "unset for direct connections.",
    );
  }
  return raw;
}

/**
 * Supavisor's SESSION-mode host for app databases, or `undefined` for direct.
 *
 * Refuses a transaction-mode URL for the same reason `assertSessionModeUrl`
 * refuses one for the admin connection, but on different grounds: there it is
 * advisory locks, here it is that the Workflow DevKit cannot run on transaction
 * pooling at all (prepared statements + LISTEN — `withPoolerHost` carries the
 * detail). Refused rather than accepted, because the failure is silent: the queue
 * appears to work and every parked run stops resuming.
 */
export function appDbPoolerUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.APP_DB_POOLER_URL?.trim();
  if (!raw) return undefined;
  assertSessionModeUrl(raw);
  return raw;
}

/** Hosts that reach Postgres over loopback, where dblink's password is unused. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", ""]);

/**
 * The libpq connection string the orphan sweep's `dblink` call opens, or a
 * REASON it cannot be built.
 *
 * `AAI_DBLINK_HOST` overrides the host because the name Postgres must dial to
 * reach ITSELF is not always the name we reach it by: on a Supabase project they
 * are the same (`db.<ref>.supabase.co`, non-loopback, SCRAM — dblink is happy),
 * but the local stack is published on `127.0.0.1:54322` while inside the compose
 * network it is `db:5432`. A loopback host is refused rather than tried, because
 * the failure it produces (`2F003`) surfaces once an hour inside a `guarded()`
 * job body — i.e. as a sweep that silently reclaims nothing, which is the exact
 * failure shape this repo keeps paying for. `scripts/dev-server.mjs` sets the
 * override for the local stack so a developer needs no manual step.
 *
 * **The override carries an optional `:port`, and it has to.** A remapped host
 * almost always means a remapped port: taking the host from here and the port from
 * `SUPABASE_DB_URL` produced `host=db port=54322` — the in-container NAME beside
 * the host-published PORT, a combination nothing is listening on. It was written
 * that way first and the resulting DSN could not connect at all.
 */
export function platformDbDsn(
  url: string,
  hostOverride?: string,
): { dsn: string } | { reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reason: "SUPABASE_DB_URL is not a URL" };
  }
  const override = hostOverride?.trim();
  // `host[:port]`. Split from the RIGHT so a bare IPv6 literal is not cut apart
  // by its own colons, and only when the tail is numeric.
  const portMatch = override === undefined ? null : /^(.*):(\d+)$/.exec(override);
  const host = portMatch?.[1] ?? override ?? parsed.hostname;
  if (!host || LOOPBACK_HOSTS.has(host.toLowerCase())) {
    return {
      reason:
        `dblink cannot reach Postgres at the loopback host "${host}": pg_cron's worker ` +
        "connects over loopback, which matches a trust rule, and dblink refuses a " +
        "non-superuser connection whose password was never used (2F003). Set " +
        "AAI_DBLINK_HOST to a name Postgres can dial itself by (the local Supabase " +
        "stack is `db`).",
    };
  }
  const password = decodeURIComponent(parsed.password);
  if (!password) return { reason: "SUPABASE_DB_URL carries no password" };
  // libpq keyword/value form, single-quoted with backslash escaping, so a
  // password containing a space or a quote cannot break out of its field.
  const field = (value: string): string =>
    `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres";
  const user = decodeURIComponent(parsed.username) || "postgres";
  // The override's port wins: see the doc above on why it cannot be taken from
  // the admin URL once the host has been replaced.
  const port = portMatch?.[2] ?? parsed.port ?? "5432";
  return {
    dsn:
      `dbname=${field(database)} user=${field(user)} password=${field(password)} ` +
      `host=${field(host)} port=${field(port)}`,
  };
}
