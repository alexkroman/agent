// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-replica sandbox registry: which live guest sandboxes exist for a
 * slug, platform-wide.
 *
 * The slot cache is per-replica, so without this two replicas serving the
 * same slug each spawn their own sandbox — duplicate guests, and
 * least-connections routing blind to the other replica's residents. The
 * registry is a lease table (`aai_platform.sandbox_registry`): the replica
 * that OWNS a resident sandbox registers it and heartbeats the lease with a
 * sampled session count (see `startRegistryHeartbeat` in
 * sandbox-resolve.ts); the broker's COLD path — no local resident — reads
 * it and routes to a live peer sandbox instead of spawning a duplicate.
 *
 * Deliberately a read at the broker, NOT a Realtime subscription: the
 * registry only matters at the moment a cold broker runs, and that moment
 * already reads the database — a change stream would be a second mechanism
 * answering the same question (the duplication rule that shaped
 * watchAgentInvalidation applies here too).
 *
 * Liveness is the lease. Only the owner can probe its guest (the control
 * channel's bearer token is per-sandbox and host-side), so peers trust
 * `expires_at`: the owner re-registers every `REGISTRY_HEARTBEAT_MS` while
 * the sandbox is its slot's live resident, and stops (unregistering) the
 * tick after it isn't. A crashed replica's rows expire within
 * `REGISTRY_LEASE_MS` and pg_cron sweeps the dead rows. The windows that
 * buys: after a crash, cold brokers elsewhere can hand out a dead peer URL
 * for up to one lease; after a local retire/evict, for up to one heartbeat.
 * Both heal on the client's re-broker, and both are the price of not
 * sharing guest credentials across replicas.
 *
 * Same two-implementation pattern as every platform store. The memory
 * registry exists for interface parity in dev/tests — a single process
 * never has peers, and `listPeers` excludes the caller's own rows, so it is
 * inert there by construction.
 */

import { ensureTableOnce } from "./pg-ensure.ts";
import type { SqlExec } from "./secret-store.ts";

/** How long one registration stays live without a heartbeat. */
export const REGISTRY_LEASE_MS = 30_000;
/** Owner re-registration cadence; must beat the lease comfortably. */
export const REGISTRY_HEARTBEAT_MS = 10_000;

export type RegisteredSandbox = {
  sessionUrl: string;
  /** Owner-sampled live session count, as of the last heartbeat. */
  sessions: number;
};

export type SandboxRegistry = {
  /** Upsert this replica's registration and renew its lease. */
  register(slug: string, sessionUrl: string, sessions: number): Promise<void>;
  /** Drop this replica's registration. Idempotent. */
  unregister(slug: string, sessionUrl: string): Promise<void>;
  /** Live (unexpired) registrations for `slug` owned by OTHER replicas. */
  listPeers(slug: string): Promise<RegisteredSandbox[]>;
};

const TABLE = "aai_platform.sandbox_registry";

/** DDL shared with nothing yet — the registry is its own bootstrap. */
const ENSURE_TABLE_SQL = `create table if not exists ${TABLE} (
  slug text not null,
  session_url text not null,
  replica_id text not null,
  sessions integer not null default 0,
  expires_at timestamptz not null,
  primary key (slug, session_url)
)`;

const REGISTER_SQL = `insert into ${TABLE} as r (slug, session_url, replica_id, sessions, expires_at)
values ($1, $2, $3, $4, now() + $5::int * interval '1 millisecond')
on conflict (slug, session_url) do update set
  replica_id = excluded.replica_id,
  sessions = excluded.sessions,
  expires_at = excluded.expires_at`;

const UNREGISTER_SQL = `delete from ${TABLE} where slug = $1 and session_url = $2`;

const LIST_SQL = `select session_url, sessions from ${TABLE}
where slug = $1 and replica_id <> $2 and expires_at > now()
order by sessions asc`;

export type PgSandboxRegistryOptions = {
  /** This process's identity — excludes its own rows from `listPeers`. */
  replicaId: string;
  leaseMs?: number;
};

/** Postgres lease-backed registry over the platform admin connection. */
export function createPgSandboxRegistry(
  sql: SqlExec,
  opts: PgSandboxRegistryOptions,
): SandboxRegistry {
  const leaseMs = opts.leaseMs ?? REGISTRY_LEASE_MS;
  const ensure = ensureTableOnce(sql, ENSURE_TABLE_SQL);

  return {
    async register(slug, sessionUrl, sessions) {
      await ensure();
      await sql(REGISTER_SQL, [slug, sessionUrl, opts.replicaId, sessions, leaseMs]);
    },
    async unregister(slug, sessionUrl) {
      await ensure();
      await sql(UNREGISTER_SQL, [slug, sessionUrl]);
    },
    async listPeers(slug) {
      await ensure();
      const rows = await sql(LIST_SQL, [slug, opts.replicaId]);
      return rows.map((row) => ({
        sessionUrl: String(row.session_url),
        sessions: Number(row.sessions) || 0,
      }));
    },
  };
}

/** In-memory registry for dev/tests — one process, so `listPeers` sees only
 * rows registered under OTHER replica ids (tests inject them). */
export function createMemorySandboxRegistry(replicaId: string): SandboxRegistry & {
  /** Test seam: register a row as another replica would. */
  registerPeer(slug: string, sessionUrl: string, sessions: number): void;
} {
  type Row = { slug: string; sessionUrl: string; replicaId: string; sessions: number };
  const rows = new Map<string, Row>();
  const key = (slug: string, sessionUrl: string) => `${slug} ${sessionUrl}`;

  return {
    register(slug, sessionUrl, sessions) {
      rows.set(key(slug, sessionUrl), { slug, sessionUrl, replicaId, sessions });
      return Promise.resolve();
    },
    unregister(slug, sessionUrl) {
      rows.delete(key(slug, sessionUrl));
      return Promise.resolve();
    },
    listPeers(slug) {
      return Promise.resolve(
        [...rows.values()]
          .filter((row) => row.slug === slug && row.replicaId !== replicaId)
          .sort((a, b) => a.sessions - b.sessions)
          .map((row) => ({ sessionUrl: row.sessionUrl, sessions: row.sessions })),
      );
    },
    registerPeer(slug, sessionUrl, sessions) {
      rows.set(key(slug, sessionUrl), {
        slug,
        sessionUrl,
        replicaId: `peer-of-${replicaId}`,
        sessions,
      });
    },
  };
}
