// Copyright 2026 the AAI authors. MIT license.
/**
 * The agents table — the control-plane record of what is deployed.
 *
 * One row per agent: identity (slug), ownership (credential hashes), and
 * content hashes pointing at the immutable blobs in Storage (worker code,
 * client files). It records NO description of what the agent is — see "The
 * platform stores no agent config" in CLAUDE.md. The row upsert is
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
 * `aai_platform.slug_epochs` counter. Deploy and delete are the mutations that
 * WRITE a row; {@link AgentRows.touch} bumps the version on its own, for a
 * mutation that changes a guest's environment without changing its code. It has
 * NO caller today — the one it existed for was app-database provisioning — and its
 * own doc says so. A secret change still takes effect on the next deploy, by
 * design.
 *
 * Postgres (`aai_platform.agents`) in production, memory in dev/tests —
 * the same two-implementation pattern as the other platform stores.
 */

import { z } from "zod";
import type { SqlExec } from "./secret-store.ts";

const AgentRecordSchema = z.object({
  slug: z.string(),
  credential_hashes: z.array(z.string()),
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
  /**
   * Bump `version` on an EXISTING row without touching the deploy it points
   * at. False when there is no such row.
   *
   * The version is the cross-replica invalidation signal, so this is how a
   * mutation that changes a guest's ENVIRONMENT rather than its code gets the
   * resident sandbox rebuilt.
   *
   * **Nothing calls it right now.** Its caller was app-database provisioning,
   * which composed a `DATABASE_URL` into the env at sandbox BUILD time
   * (`sandbox-resolve.ts`) — so without a bump the running guest kept the env it
   * was spawned with and the change silently took effect on some later deploy.
   * The method is kept rather than deleted because it is the seam that failure
   * mode needs, it is implemented by all three stores, and the conformance cases
   * pin the contract; a future env-only mutation should use it rather than
   * rediscovering the bug. Nothing else here may reach for it: a change to the deploy itself
   * goes through {@link put}, which bumps on its own.
   */
  touch(slug: string): Promise<boolean>;
};

const TABLE = "aai_platform.agents";
const GET_SQL = `select slug, credential_hashes, worker_hash, client_files,
  harness_image_tag, version
from ${TABLE} where slug = $1`;

const PUT_SQL = `insert into ${TABLE} as a
  (slug, credential_hashes, worker_hash, client_files, harness_image_tag, version)
values ($1, $2::text::jsonb, $3, $4::text::jsonb, $5, 1)
on conflict (slug) do update set
  credential_hashes = excluded.credential_hashes,
  worker_hash = excluded.worker_hash,
  client_files = excluded.client_files,
  harness_image_tag = excluded.harness_image_tag,
  version = a.version + 1,
  updated_at = now()`;

const DELETE_SQL = `delete from ${TABLE} where slug = $1`;
// `returning` rather than a separate existence read: one statement, and it
// answers the "no such row" case without a race against a concurrent delete.
const TOUCH_SQL = `update ${TABLE} set version = version + 1, updated_at = now()
where slug = $1 returning version`;
const VERSION_SQL = `select version from ${TABLE} where slug = $1`;

/** Postgres-backed agent rows over the platform admin connection. */
export function createPgAgentRows(sql: SqlExec): AgentRows {
  return {
    async get(slug) {
      const rows = await sql(GET_SQL, [slug]);
      const row = rows[0];
      if (!row) return null;
      const parsed = AgentRecordSchema.safeParse({
        slug: row.slug,
        credential_hashes: row.credential_hashes,
        worker_hash: row.worker_hash,
        client_files: row.client_files,
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
      await sql(PUT_SQL, [
        record.slug,
        JSON.stringify(record.credential_hashes),
        record.worker_hash,
        JSON.stringify(record.client_files),
        record.harness_image_tag ?? null,
      ]);
    },

    async delete(slug) {
      await sql(DELETE_SQL, [slug]);
    },

    async getVersion(slug) {
      const rows = await sql(VERSION_SQL, [slug]);
      const raw = rows[0]?.version;
      return raw == null ? null : Number(raw);
    },

    async touch(slug) {
      const rows = await sql(TOUCH_SQL, [slug]);
      return rows.length > 0;
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
    touch(slug) {
      const row = rows.get(slug);
      if (!row) return Promise.resolve(false);
      rows.set(slug, { ...row, version: row.version + 1 });
      return Promise.resolve(true);
    },
  };
}
