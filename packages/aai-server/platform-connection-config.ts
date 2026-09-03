// Copyright 2026 the AAI authors. MIT license.
/**
 * WHICH Postgres connection the platform opens for what, and in which mode.
 *
 * Split out of `service-config.ts` (which was over the file-length cap) along a
 * real seam rather than an arbitrary one: these resolvers answer one question —
 * may this connection be POOLED, and how — and the answer is measured rather
 * than chosen. `supabase/config.toml`'s pooler stanza carries the run:
 *
 * - `SUPABASE_DB_URL` stays SESSION-mode, because the slug lock is a
 *   session-scoped `pg_advisory_lock` and a rival connection acquired the same
 *   lock through a transaction pooler. That is the silent loss of mutual
 *   exclusion `assertSessionModeUrl` exists to prevent, and it had never been
 *   reproduced before. Note "session-mode", not "direct": Supavisor's port-5432
 *   endpoint pins a backend for the connection's lifetime and satisfies the lock
 *   just as well, and on Supabase the DIRECT host resolves to IPv6 only unless
 *   the project buys the IPv4 add-on — so "direct" is the value that took
 *   production down (see {@link announceDirectDbHost}).
 * - The ADMIN pool may be TRANSACTION-pooled: the only lock on it is
 *   `pg_try_advisory_xact_lock` inside `begin … commit`, whose lifetime is
 *   exactly the transaction a pooler pins a backend for — verified correct
 *   including a rival refused while held and release on commit.
 * - A `LISTEN` must be SESSION-mode, because the subscription is state in one
 *   backend's session and a transaction pooler hands that backend on after every
 *   statement — Supavisor does not support it there at all
 *   (supabase/supavisor#85). This bullet used to be about APP DATABASES, which
 *   hosted the Workflow DevKit and needed session mode for three reasons:
 *   graphile-worker's NAMED prepared statements, `world-postgres`'s `LISTEN`
 *   client with no polling fallback, and `workflow-lock-sweep.ts`'s
 *   session-scoped advisory lock. There are no app databases now, and the rule
 *   survived the move rather than going with them: the DevKit's world and the
 *   queue sweep's `NOTIFY` listener both run on `SUPABASE_DB_URL`, the listener
 *   on a handle of its OWN (`service-config.ts`) — because for a while it did
 *   not, and a `LISTEN` through the transaction-pooled admin pool established
 *   fine and delivered nothing. (The prepared-statement leg is the one to stop
 *   citing as current: Supavisor is reported to parse `PREPARE` and broadcast it
 *   across backends now. Not verified here, and nothing rests on it — the other
 *   two legs stand on their own, and neither one is about a database we
 *   provision.)
 *
 * `platform-connection-config.test.ts` pins every rule here, including the two
 * refusals that read backwards until you see what they prevent.
 */

import { createLogger } from "./logger.ts";
import { isTransactionModePooler } from "./platform-lock.ts";

const log = createLogger("platform.connections");

/**
 * Supabase's DIRECT endpoint for a project: `db.<ref>.supabase.co`.
 *
 * Two facts about this host, and the second is the expensive one. It is not a
 * pooler and never can be — Supavisor answers on `*.pooler.supabase.com` — and
 * on a project without the IPv4 add-on it has **no A record at all**, only
 * AAAA. Every IPv4-only runtime (Modal's containers included) therefore fails
 * `getaddrinfo ENOTFOUND` on it, at every query, forever.
 */
const SUPABASE_DIRECT_HOST = /^db\..+\.supabase\.co$/;

/** The URL's hostname, or `undefined` when it does not parse as one. */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    // Not our business to validate connection strings in general — the driver
    // rejects an unusable one with a better message than we can. Same policy as
    // `assertSessionModeUrl`.
    return undefined;
  }
}

/**
 * Refuse a POOLER URL that names Supabase's direct endpoint.
 *
 * This is a HOST check because the mode checks beside it cannot be one, and
 * production paid for the difference: `isTransactionModePooler` asks about the
 * port (`6543`) or an explicit `pgbouncer=true`, so the direct connection
 * string with its port changed to 6543 is *mode-valid* and completely
 * non-functional. Set as `PLATFORM_POOLER_URL`, it took the admin pool — and
 * with it agents rows, Vault, workspaces, chats, pg_cron scheduling, the
 * capacity read and the durable-workflow wake sweep — to a hostname with no A
 * record, while `/health` kept answering 200 and the boot log's only clue was
 * that the "no PLATFORM_POOLER_URL" warning had stopped printing.
 *
 * **It is deliberately NOT "the pooler host must differ from
 * `SUPABASE_DB_URL`'s".** That rule reads right and refuses the correct
 * configuration: production's two vars are the same Supavisor HOSTNAME on
 * different ports (5432 session, 6543 transaction), and the local stack puts
 * Supavisor and Postgres both on `127.0.0.1`. Hostname equality does not
 * separate the working config from the broken one; "is this the direct
 * endpoint" does.
 *
 * Scoped to Supabase-managed hostnames, so a self-hosted Supavisor, a proxy or
 * a loopback forward is judged by nothing here.
 */
function assertNotDirectHost(raw: string, varName: string): void {
  const hostname = hostnameOf(raw);
  if (hostname === undefined || !SUPABASE_DIRECT_HOST.test(hostname)) return;
  throw new Error(
    `${varName} names Supabase's DIRECT endpoint (${hostname}), which is not a pooler. ` +
      "Supavisor answers on <region>.pooler.supabase.com; the direct host also has no IPv4 " +
      "address unless the project buys the add-on, so every connection through it fails " +
      "`getaddrinfo ENOTFOUND`. Changing the direct string's PORT to a pooler port does not " +
      "make it a pooler — it passes the mode check and reaches nothing.",
  );
}

/**
 * Supavisor's TRANSACTION-mode URL for the platform ADMIN pool, or `undefined`.
 *
 * TRANSACTION mode, forced. It is what actually multiplexes — a session-mode pool holds one server
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
  assertNotDirectHost(raw, "PLATFORM_POOLER_URL");
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
 * Announce a `SUPABASE_DB_URL` that names Supabase's direct endpoint.
 *
 * WARNED rather than refused, and the asymmetry with {@link assertNotDirectHost}
 * is the whole point: a direct session-mode connection is a legitimate value
 * here — it is what `assertSessionModeUrl`'s own error recommends, and it is
 * correct on a project that bought the IPv4 add-on or on any IPv6-capable
 * runtime. It is only *unreachable* on this platform's deployment, which no
 * string can tell. So this names the trap and leaves the choice.
 *
 * A warning is a weak instrument and this file knows it. The strong version is
 * a boot-time `select 1` that FAILS the boot rather than logging — deliberately
 * not done here, because it turns a Supabase blip during a deploy into a
 * deployment that will not start, which is a trade for an operator to make
 * rather than a detail of a config reader.
 */
export function announceDirectDbHost(env: NodeJS.ProcessEnv): void {
  const raw = env.SUPABASE_DB_URL?.trim();
  const hostname = raw ? hostnameOf(raw) : undefined;
  if (hostname === undefined || !SUPABASE_DIRECT_HOST.test(hostname)) return;
  log.warn(
    `SUPABASE_DB_URL points at Supabase's DIRECT host (${hostname}). That host has no IPv4 ` +
      "address unless the project bought the add-on, and this platform's containers are " +
      "IPv4-only — so if the next line is a capacity read that failed with ENOTFOUND, this is " +
      "why. Supavisor's SESSION-mode URL (port 5432 on <region>.pooler.supabase.com) is " +
      "reachable and keeps the connection affinity the slug lock needs.",
  );
}
