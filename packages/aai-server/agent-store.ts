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
 * `aai_platform.slug_epochs` counter — deploy/delete are the only mutations
 * that move sandboxes now; secret and storage changes take effect on the
 * next deploy (or sandbox rebuild), by design.
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
   * Deployed slugs in SLUG ORDER, bounded by `limit`, starting after `after`.
   *
   * For the workflow wake sweep (`workflow-wake.ts`), which has to turn "some
   * app has a run due" into "boot that app" without reading tenant data to find
   * the candidates. Slugs are the platform's own record; the schema name is
   * derived from one (`appDbIdentifier`), so this is the enumeration that makes a
   * schema-scoped journal query possible at all — the identifier is a one-way
   * hash, so the reverse direction does not exist.
   *
   * **`after` is what makes a fleet past `limit` reachable, and it is not
   * optional in spirit.** Slug order alone is stable, which is necessary and not
   * sufficient: without a cursor every tick returns the SAME first page forever,
   * so an agent sorting past `MAX_WAKE_CANDIDATE_SLUGS` is never a wake candidate
   * and its runs never resume — the exact failure the bound's doc promised was
   * only lateness. The caller advances the cursor per tick and wraps at the end.
   *
   * Slug order rather than age order: it is the primary key, so the scan is an
   * index walk with no extra column, and for a rotating cursor the only property
   * that matters is that the order does not change between ticks.
   */
  listSlugs(limit: number, after?: string): Promise<string[]>;
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

// `$2` is the exclusive cursor; `null` starts from the beginning. Compared as
// text so one statement serves both cases without a second query shape.
const LIST_SLUGS_SQL = `select slug from ${TABLE}
 where $2::text is null or slug > $2::text
 order by slug limit $1`;

/** Postgres-backed agent rows over the platform admin connection. */
export function createPgAgentRows(sql: SqlExec): AgentRows {
  return {
    async get(slug) {
      const rows = await sql(GET_SQL, [slug]);
      const row = rows[0];
      if (!row) return null;
      const parsed = AgentRecordSchema.safeParse({
        slug: row.slug,
        credential_hashes: jsonColumn(row.credential_hashes),
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

    async listSlugs(limit, after) {
      const rows = await sql(LIST_SLUGS_SQL, [limit, after ?? null]);
      return rows.map((row) => String(row.slug));
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
    listSlugs(limit, after) {
      // Sorted, matching the Postgres `order by slug` — a Map's insertion order
      // would make the fake's window shuffle where the real one is stable — and
      // filtered by the same exclusive cursor, so a test can observe a sweep
      // advancing across ticks rather than only the first page.
      const ordered = [...rows.keys()].sort();
      const page = after === undefined ? ordered : ordered.filter((slug) => slug > after);
      return Promise.resolve(page.slice(0, limit));
    },
  };
}
