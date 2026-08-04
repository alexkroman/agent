// Copyright 2026 the AAI authors. MIT license.
/**
 * The agents table — the control-plane record of what is deployed.
 *
 * One row per agent: identity (slug), ownership (credential hashes), the
 * bundle's self-described config, and content hashes pointing at the
 * immutable blobs in Storage (worker code, client files). The row upsert is
 * the ATOMIC COMMIT POINT of a deploy: blobs are written first under
 * content-addressed keys, then the row flips to reference them, so a
 * half-finished deploy is never visible and in-flight readers of the
 * previous deploy keep resolving its (untouched) blobs.
 *
 * `version` increments on every put and doubles as the cross-replica
 * invalidation signal: a resident sandbox records the version it was built
 * from, and the agents row's change stream retires residents at another
 * version (`watchAgentInvalidation` in sandbox-resolve.ts — there is no
 * per-broker check or idle-sweep probe). This replaced the separate
 * `aai_platform.slug_epochs` counter — deploy/delete are the only mutations
 * that move sandboxes now; secret and storage changes take effect on the
 * next deploy (or sandbox rebuild), by design.
 *
 * Postgres (`aai_platform.agents`) in production, memory in dev/tests —
 * the same two-implementation pattern as the other platform stores.
 */

import { z } from "zod";
import { ensureTableOnce } from "./pg-ensure.ts";
import type { SqlExec } from "./secret-store.ts";

/**
 * The host's read-side view of a STORED agent config — FULLY opaque.
 *
 * A stored config was validated by the FULL `IsolateConfigSchema` once, at
 * deploy time, against the rules current then. Re-validating it against
 * TODAY'S rules on every row read is a cross-version seam: any tightening of
 * the config schema would make previously-valid deployed agents read as
 * "corrupt … missing" (a 404) without anyone touching them. So reads assert
 * nothing beyond "it is an object": the host has NO field-level reader left —
 * even name/greeting come from the guest's own `/client-config` now (see
 * client-config-handler.ts) — and the row's copy exists only to round-trip
 * through storage. The bundle interprets its own config with the SDK it
 * shipped with.
 *
 * Do not add fields here, and never add a refinement: strictness belongs at
 * the deploy boundary (`validateAgentConfig` in deploy.ts), which always
 * runs on the current CLI's freshly extracted config.
 */
export const StoredAgentConfigSchema = z.record(z.string(), z.unknown());

export type StoredAgentConfig = z.infer<typeof StoredAgentConfigSchema>;

const AgentRecordSchema = z.object({
  slug: z.string(),
  credential_hashes: z.array(z.string()),
  /**
   * The bundle's self-described config, extracted guest-side at deploy —
   * opaque on reads (see StoredAgentConfigSchema).
   */
  config: StoredAgentConfigSchema,
  /** Content hash (sha-256 hex) of the worker bundle blob. */
  worker_hash: z.string(),
  /** Client file path → content hash of its blob. */
  client_files: z.record(z.string(), z.string()),
  /**
   * The harness snapshot image this deploy ran against (content-addressed
   * tag — see modal-harness-image.ts), so its sandbox can be re-spawned on
   * that same image after platform upgrades. Null for deploys made outside
   * the Modal backend (local dev, tests) and rows predating the column.
   */
  harness_image_tag: z.string().nullish().default(null),
  /** Deploy counter — bumped by every put; the invalidation signal. */
  version: z.number().int().positive(),
});

export type AgentRecord = z.infer<typeof AgentRecordSchema>;
export type AgentRecordInput = Omit<AgentRecord, "version" | "harness_image_tag"> & {
  harness_image_tag?: string | null | undefined;
};

export type AgentRows = {
  get(slug: string): Promise<AgentRecord | null>;
  /** Upsert the deploy record; bumps `version`. The deploy's commit point. */
  put(record: AgentRecordInput): Promise<void>;
  delete(slug: string): Promise<void>;
  /** Current version, or null when the agent does not exist (deleted). */
  getVersion(slug: string): Promise<number | null>;
};

const TABLE = "aai_platform.agents";
/** DDL shared with the boot-time Realtime publication setup (realtime-events.ts). */
export const ENSURE_AGENTS_TABLE_SQL = `create table if not exists ${TABLE} (
  slug text primary key,
  credential_hashes jsonb not null,
  config jsonb not null,
  worker_hash text not null,
  client_files jsonb not null,
  harness_image_tag text,
  version bigint not null,
  updated_at timestamptz not null default now()
);
alter table ${TABLE} add column if not exists harness_image_tag text`;

const GET_SQL = `select slug, credential_hashes, config, worker_hash, client_files,
  harness_image_tag, version
from ${TABLE} where slug = $1`;

const PUT_SQL = `insert into ${TABLE} as a
  (slug, credential_hashes, config, worker_hash, client_files, harness_image_tag, version)
values ($1, $2::jsonb, $3::jsonb, $4, $5::jsonb, $6, 1)
on conflict (slug) do update set
  credential_hashes = excluded.credential_hashes,
  config = excluded.config,
  worker_hash = excluded.worker_hash,
  client_files = excluded.client_files,
  harness_image_tag = excluded.harness_image_tag,
  version = a.version + 1,
  updated_at = now()`;

const DELETE_SQL = `delete from ${TABLE} where slug = $1`;
const VERSION_SQL = `select version from ${TABLE} where slug = $1`;

/** jsonb columns may come back parsed (pg) or as text (driver-dependent). */
function jsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Postgres-backed agent rows over the platform admin connection. */
export function createPgAgentRows(sql: SqlExec): AgentRows {
  const ensure = ensureTableOnce(sql, ENSURE_AGENTS_TABLE_SQL);

  return {
    async get(slug) {
      await ensure();
      const rows = await sql(GET_SQL, [slug]);
      const row = rows[0];
      if (!row) return null;
      const parsed = AgentRecordSchema.safeParse({
        slug: row.slug,
        credential_hashes: jsonColumn(row.credential_hashes),
        config: jsonColumn(row.config),
        worker_hash: row.worker_hash,
        client_files: jsonColumn(row.client_files),
        harness_image_tag: row.harness_image_tag ?? null,
        version: Number(row.version),
      });
      if (!parsed.success) {
        // Corrupt stored row — fail CLOSED, never "missing". A null here
        // reaches verifySlugOwner as {status: "unclaimed"}, the one state
        // where any API key may claim the slug: one unparseable column (or
        // a schema tightening that rejects old rows) would turn a live,
        // owned agent into a slug another tenant's deploy can take over,
        // while data routes 404 the real owner. Throwing makes the slug
        // error loudly until the row is fixed instead.
        throw new Error(`Corrupt agent record for ${slug}: ${parsed.error.message}`);
      }
      return parsed.data;
    },

    async put(record) {
      await ensure();
      await sql(PUT_SQL, [
        record.slug,
        JSON.stringify(record.credential_hashes),
        JSON.stringify(record.config),
        record.worker_hash,
        JSON.stringify(record.client_files),
        record.harness_image_tag ?? null,
      ]);
    },

    async delete(slug) {
      await ensure();
      await sql(DELETE_SQL, [slug]);
    },

    async getVersion(slug) {
      await ensure();
      const rows = await sql(VERSION_SQL, [slug]);
      const raw = rows[0]?.version;
      return raw == null ? null : Number(raw);
    },
  };
}

/** In-memory agent rows for local dev and tests — same semantics. */
export function createMemoryAgentRows(): AgentRows {
  const rows = new Map<string, AgentRecord>();
  return {
    get(slug) {
      return Promise.resolve(rows.get(slug) ?? null);
    },
    put(record) {
      const version = (rows.get(record.slug)?.version ?? 0) + 1;
      // Structured-clone so callers can't mutate stored state through the
      // input object (parity with the Postgres round trip).
      rows.set(
        record.slug,
        structuredClone({
          ...record,
          harness_image_tag: record.harness_image_tag ?? null,
          version,
        }),
      );
      return Promise.resolve();
    },
    delete(slug) {
      rows.delete(slug);
      return Promise.resolve();
    },
    getVersion(slug) {
      return Promise.resolve(rows.get(slug)?.version ?? null);
    },
  };
}
