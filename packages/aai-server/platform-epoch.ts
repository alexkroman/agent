// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-replica (and cross-service) slug epochs — the invalidation signal
 * for resident sandboxes.
 *
 * A deploy/secret/storage mutation restarts the resident sandbox on the
 * replica that handled it (`terminateSlot`/`restartSlotSandbox`), but other
 * replicas — and, with the studio running as its own service, the agent
 * service entirely — would keep serving sessions from a sandbox built on
 * pre-mutation code/config until idle eviction. Every mutation therefore
 * bumps the slug's epoch here, and `resolveSandbox` compares the resident
 * sandbox's epoch against the current one at session start: a mismatch
 * terminates the stale sandbox (and drops the bundle-store caches) so the
 * session builds against the freshly stored bundle.
 *
 * One monotonic counter per slug rather than per-artifact versions: the
 * sandbox is built from the *combination* of worker code, env, and app-db
 * credentials, so any mutation invalidates the whole thing.
 *
 * Postgres (`aai_platform.slug_epochs`) in production, memory in dev/tests
 * — same two-implementation pattern as the other platform stores.
 */

import { errorMessage } from "@alexkroman1/aai";
import { ensureTableOnce } from "./pg-ensure.ts";
import type { SqlExec } from "./secret-store.ts";

export type SlugEpochs = {
  /** Invalidate every replica's resident sandbox for `slug`. */
  bump(slug: string): Promise<void>;
  /** Current epoch for `slug` (0 when never bumped). */
  get(slug: string): Promise<number>;
};

const TABLE = "aai_platform.slug_epochs";
const ENSURE_TABLE_SQL = `create table if not exists ${TABLE} (
  slug text primary key,
  epoch bigint not null,
  updated_at timestamptz not null default now()
)`;

const BUMP_SQL = `insert into ${TABLE} as e (slug, epoch) values ($1, 1)
on conflict (slug) do update set epoch = e.epoch + 1, updated_at = now()`;

const GET_SQL = `select epoch from ${TABLE} where slug = $1`;

/** Postgres-backed epochs over the platform admin connection. */
export function createPgSlugEpochs(sql: SqlExec): SlugEpochs {
  const ensure = ensureTableOnce(sql, ENSURE_TABLE_SQL);

  return {
    async bump(slug) {
      await ensure();
      await sql(BUMP_SQL, [slug]);
    },
    async get(slug) {
      await ensure();
      const rows = await sql(GET_SQL, [slug]);
      const raw = rows[0]?.epoch;
      return raw == null ? 0 : Number(raw);
    },
  };
}

/** In-memory epochs for dev/tests — same semantics. */
export function createMemorySlugEpochs(): SlugEpochs {
  const epochs = new Map<string, number>();
  return {
    bump(slug) {
      epochs.set(slug, (epochs.get(slug) ?? 0) + 1);
      return Promise.resolve();
    },
    get(slug) {
      return Promise.resolve(epochs.get(slug) ?? 0);
    },
  };
}

/**
 * Bump `slug`'s epoch, best-effort. Mutations call this after their write
 * lands: the write is the source of truth and MUST NOT be rolled back or
 * reported failed because the invalidation signal didn't go out — the
 * fallback is the same staleness window (idle eviction, cache TTLs) that
 * existed before epochs.
 */
export async function bumpSlugEpoch(epochs: SlugEpochs, slug: string): Promise<void> {
  try {
    await epochs.bump(slug);
  } catch (err) {
    console.warn(`Failed to bump slug epoch for ${slug}: ${errorMessage(err)}`);
  }
}

/**
 * Read `slug`'s current epoch, degrading to "matches whatever the resident
 * sandbox has" on a read failure: a session start must not die because the
 * invalidation check couldn't run.
 */
export async function readSlugEpoch(
  epochs: SlugEpochs,
  slug: string,
  fallback: number,
): Promise<number> {
  try {
    return await epochs.get(slug);
  } catch (err) {
    console.warn(`Failed to read slug epoch for ${slug}: ${errorMessage(err)}`);
    return fallback;
  }
}
