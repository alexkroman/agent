// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-replica sandbox registry: which live guest sandbox is already
 * serving a slug, platform-wide.
 *
 * The slot cache is per-replica, and the web service autoscales, so without
 * this two replicas serving the same slug each spawn their own guest. That
 * costs a duplicate Modal sandbox per replica — billed, and (for studio
 * sandboxes) a second writer to the same workspace row. Modal load-balances
 * every request independently, so this is not an edge case: a page load and
 * the project switch a minute later routinely land on different replicas.
 *
 * The registry is a lease table (`aai_platform.sandbox_registry`): the
 * replica that OWNS a resident registers it and heartbeats the lease
 * (`startRegistryHeartbeat` in sandbox-resolve.ts); the broker's COLD path —
 * no local resident — reads it and routes to the live peer sandbox instead
 * of spawning a duplicate. Sessions dial the guest's tunnel directly, so a
 * peer's URL is as good as a local one: the host is not in the audio path.
 *
 * Deliberately a read at the broker, NOT a Realtime subscription: the
 * registry only matters at the moment a cold broker runs, and that moment
 * already reads the database — a change stream would be a second mechanism
 * answering the same question (the duplication rule that shaped
 * `watchAgentInvalidation` applies here too).
 *
 * Liveness is the lease. A peer's guest is not ours to probe — the
 * `/manage/*` bearer is per-sandbox and stays with its owner — so peers
 * trust `expires_at`: the owner re-registers every
 * {@link REGISTRY_HEARTBEAT_MS} while the sandbox is its slot's live
 * resident, and stops (unregistering) the tick after it isn't. A crashed
 * replica's rows expire within {@link REGISTRY_LEASE_MS} and pg_cron sweeps
 * the dead rows. The windows that buys: after a crash, cold brokers
 * elsewhere can hand out a dead peer URL for up to one lease; after a local
 * retire/evict, for up to one heartbeat. Both heal on the client's
 * re-broker — `session-core.ts` re-brokers per attempt — and both are the
 * price of not sharing guest credentials across replicas.
 *
 * This registry answers only "is a live peer serving this slug"; it does NOT
 * choose between peers. Per-slug horizontal scaling (session caps, overflow
 * replicas, least-connections routing over guest-reported counts) stays
 * deleted — see the "No horizontal sandbox scaling" note in CLAUDE.md. Each
 * replica still holds at most one resident per slug; the registry keeps the
 * fleet from holding N of them.
 *
 * Same two-implementation pattern as every platform store. The memory
 * registry exists for interface parity in dev/tests — a single process never
 * has peers, and `findPeer` excludes the caller's own rows, so it is inert
 * there by construction.
 */

import { ensureTableOnce } from "./pg-ensure.ts";
import type { SqlExec } from "./secret-store.ts";

/** How long one registration stays live without a heartbeat. */
export const REGISTRY_LEASE_MS = 30_000;
/** Owner re-registration cadence; must beat the lease comfortably. */
export const REGISTRY_HEARTBEAT_MS = 10_000;

/**
 * A live sandbox as a peer replica sees it. Both URLs are public (the Modal
 * tunnel) — the per-sandbox bearer that gates `/manage/*` is deliberately
 * NOT here: a peer routes clients to the guest, it does not manage it.
 */
export type RegisteredSandbox = {
  /** The guest's public session endpoint — what the broker hands clients. */
  sessionUrl: string;
  /** The guest's origin, for the broker's `/client-config` proxy. */
  guestOrigin: string;
};

export type SandboxRegistry = {
  /** Upsert this replica's registration and renew its lease. */
  register(slug: string, entry: RegisteredSandbox): Promise<void>;
  /** Drop this replica's registration. Idempotent. */
  unregister(slug: string, sessionUrl: string): Promise<void>;
  /** A live (unexpired) registration for `slug` owned by ANOTHER replica. */
  findPeer(slug: string): Promise<RegisteredSandbox | null>;
};

const TABLE = "aai_platform.sandbox_registry";

const ENSURE_TABLE_SQL = `create table if not exists ${TABLE} (
  slug text not null,
  session_url text not null,
  guest_origin text not null,
  replica_id text not null,
  expires_at timestamptz not null,
  primary key (slug, session_url)
)`;

/** The sweep and `findPeer` both filter on it; the PK doesn't cover it. */
const ENSURE_INDEX_SQL = `create index if not exists sandbox_registry_expires_at
  on ${TABLE} (expires_at)`;

const REGISTER_SQL = `insert into ${TABLE} as r
  (slug, session_url, guest_origin, replica_id, expires_at)
values ($1, $2, $3, $4, now() + $5::int * interval '1 millisecond')
on conflict (slug, session_url) do update set
  guest_origin = excluded.guest_origin,
  replica_id = excluded.replica_id,
  expires_at = excluded.expires_at`;

const UNREGISTER_SQL = `delete from ${TABLE} where slug = $1 and session_url = $2`;

// Freshest lease first: with several peers registered, the one heartbeated
// most recently is the likeliest to still be alive.
const FIND_PEER_SQL = `select session_url, guest_origin from ${TABLE}
where slug = $1 and replica_id <> $2 and expires_at > now()
order by expires_at desc
limit 1`;

export type PgSandboxRegistryOptions = {
  /** This process's identity — excludes its own rows from `findPeer`. */
  replicaId: string;
  leaseMs?: number;
};

/** Postgres lease-backed registry over the platform admin connection. */
export function createPgSandboxRegistry(
  sql: SqlExec,
  opts: PgSandboxRegistryOptions,
): SandboxRegistry {
  const leaseMs = opts.leaseMs ?? REGISTRY_LEASE_MS;
  const ensure = ensureTableOnce(sql, ENSURE_TABLE_SQL, ENSURE_INDEX_SQL);

  return {
    async register(slug, entry) {
      await ensure();
      await sql(REGISTER_SQL, [slug, entry.sessionUrl, entry.guestOrigin, opts.replicaId, leaseMs]);
    },
    async unregister(slug, sessionUrl) {
      await ensure();
      await sql(UNREGISTER_SQL, [slug, sessionUrl]);
    },
    async findPeer(slug) {
      await ensure();
      const rows = await sql(FIND_PEER_SQL, [slug, opts.replicaId]);
      const row = rows[0];
      if (!row) return null;
      return { sessionUrl: String(row.session_url), guestOrigin: String(row.guest_origin) };
    },
  };
}

/**
 * In-memory registry for dev/tests — one process, so `findPeer` sees only
 * rows registered under OTHER replica ids (tests inject them).
 */
export function createMemorySandboxRegistry(replicaId: string): SandboxRegistry & {
  /** Test seam: register a row as another replica would. */
  registerPeer(slug: string, entry: RegisteredSandbox): void;
} {
  type Row = RegisteredSandbox & { slug: string; replicaId: string };
  const rows = new Map<string, Row>();
  const key = (slug: string, sessionUrl: string): string => `${slug} ${sessionUrl}`;

  return {
    register(slug, entry) {
      rows.set(key(slug, entry.sessionUrl), { ...entry, slug, replicaId });
      return Promise.resolve();
    },
    unregister(slug, sessionUrl) {
      rows.delete(key(slug, sessionUrl));
      return Promise.resolve();
    },
    findPeer(slug) {
      const peer = [...rows.values()].find(
        (row) => row.slug === slug && row.replicaId !== replicaId,
      );
      return Promise.resolve(
        peer ? { sessionUrl: peer.sessionUrl, guestOrigin: peer.guestOrigin } : null,
      );
    },
    registerPeer(slug, entry) {
      rows.set(key(slug, entry.sessionUrl), {
        ...entry,
        slug,
        replicaId: `peer-of-${replicaId}`,
      });
    },
  };
}
