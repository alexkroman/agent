// Copyright 2026 the AAI authors. MIT license.
/**
 * Persistence for studio project workspaces — one row per project with an
 * optimistic version counter, mirroring the `SecretStore` pattern: a
 * Postgres implementation over the platform's `SqlExec` (Supabase, same
 * connection Vault uses) for production, and a Map-backed one with identical
 * semantics for local dev and tests. Blob `Storage` no longer holds
 * workspaces; it serves only deploy artifacts (bundles/client files).
 *
 * Concurrency contract: `get` returns the document with its `version`;
 * `put` succeeds only against the exact version it read (`null` = create,
 * which must not find an existing row) and throws {@link
 * WorkspaceConflictError} otherwise. In-process writers are additionally
 * serialized by `mutateWorkspace`'s keyed lock (`studio-workspace.ts`), so
 * a conflict here means a concurrent writer on another replica —
 * `mutateWorkspace` absorbs those by re-reading and re-applying once.
 *
 * The table lives in the `aai_platform` schema, not `public`. The original reason
 * was that per-app tenant schemas (`app_<hex>`) shared this database and
 * platform-internal tables wanted their own namespace; nothing tenant-owned is in
 * here now, and the namespace stays because `public` is also where a
 * self-hosted operator's own tables would land.
 */

import { projectKey, splitProjectKey } from "./platform-events.ts";
import type { SqlExec } from "./secret-store.ts";

/** A stored workspace document with its optimistic-concurrency version. */
export type WorkspaceRecord = {
  doc: unknown;
  version: number;
};

/** Thrown when a versioned write loses a race (or a create finds a row). */
export class WorkspaceConflictError extends Error {
  constructor(scope: string, project: string) {
    super(`Workspace write conflict for ${scope}/${project}`);
    this.name = "WorkspaceConflictError";
  }
}

/**
 * A shallow edit to a stored document's top-level keys: `set` merges, `remove`
 * deletes. Everything not named is left exactly as stored — which is the
 * point, since the key NOT named is `files`.
 */
export type WorkspacePatch = {
  set?: Record<string, unknown>;
  remove?: string[];
};

export type WorkspaceStore = {
  /** The stored document and its version, or null when absent. */
  get(scope: string, project: string): Promise<WorkspaceRecord | null>;
  /**
   * Apply a shallow patch to an existing document's top-level keys, bumping
   * the version. Resolves the resulting record, or null when there is no row
   * (a project deleted mid-flight is never resurrected — same rule as the
   * versioned put).
   *
   * This exists because METADATA STAMPS dominate workspace writes and none of
   * them touch the file map. Every settled edit is followed by a preview
   * deploy stamping `previewSlug`/`previewHash`, Publish stamps
   * `deployedSlug`/`deployedHash`, the database switch stamps
   * `databaseEnabled` — and each of those went through a read-modify-write of
   * the WHOLE document, so recording a 64-character hash read and rewrote
   * every file in the project. Twice, counting the read.
   *
   * It is also the stronger concurrency primitive for that job, not merely
   * the cheaper one. A versioned RMW can only be correct by DETECTING that
   * the files moved under it and retrying; a patch cannot clobber them,
   * because it never carries them. The version bump is kept because it is
   * what the change stream — and so the studio's SSE push — is driven by.
   */
  patch(scope: string, project: string, patch: WorkspacePatch): Promise<WorkspaceRecord | null>;
  /**
   * Versioned write. `expectedVersion: null` creates the row and conflicts
   * when one already exists; a number replaces exactly that version.
   * Resolves with the new version.
   *
   * @throws {WorkspaceConflictError} on a version mismatch or creation race.
   */
  put(
    scope: string,
    project: string,
    doc: unknown,
    expectedVersion: number | null,
  ): Promise<number>;
  /** Remove the row. Idempotent. */
  delete(scope: string, project: string): Promise<void>;
  /** Project names in a scope, sorted. */
  list(scope: string): Promise<string[]>;
};

const TABLE = "aai_platform.studio_workspaces";

/**
 * Postgres-backed workspace store over the platform admin connection.
 *
 * The table is declared in `supabase/migrations` (in `aai_platform`,
 * deliberately not `public`), so this store issues no DDL. Documents are bound
 * as JSON text with a `::jsonb` cast so the statement shape is
 * driver-agnostic; reads take the parsed object the `postgres` driver returns.
 *
 * **The cast is `::text::jsonb`, and the extra step is load-bearing.** Bound to
 * a bare `$n::jsonb`, postgres.js resolves the parameter's type FROM that cast
 * and JSON-encodes the string we already encoded — so the column ends up
 * holding a jsonb *string* rather than an object. Measured against a real
 * Postgres: `$3::jsonb` stores `jsonb_typeof = 'string'`, `$3::text::jsonb`
 * stores `'object'`. Pinning the parameter to `text` makes Postgres do the
 * parse, which is what was intended all along.
 *
 * It was invisible for as long as it was because NOTHING read the column from
 * inside Postgres — every reader round-tripped the value through JS, where a
 * string-tolerant read in each store peeled the extra layer off. The two things
 * that DID reach into the jsonb both failed silently or late:
 *
 * - `patch` below (`doc - text[]`) threw **`cannot delete from scalar`**, which
 *   is how this was found — every metadata stamp in production, so every
 *   preview deploy, Publish, and database toggle;
 * - the orphan-preview sweep (`pg-cron.ts`) skips an agent whose slug some
 *   workspace still names, via `doc->>'previewSlug'` — which reads NULL out of
 *   a string, so the predicate matched nothing and the sweep deleted LIVE
 *   previews. That is the "swept preview" the Preview pane's wake exists to
 *   recover from; it was not a rare race, it was every preview, hourly.
 */
export function createPgWorkspaceStore(sql: SqlExec): WorkspaceStore {
  return {
    async get(scope, project) {
      const rows = await sql(
        `select doc, version from ${TABLE} where scope = $1 and project = $2`,
        [scope, project],
      );
      const row = rows[0];
      if (!row) return null;
      return { doc: row.doc, version: Number(row.version) };
    },

    async put(scope, project, doc, expectedVersion) {
      const json = JSON.stringify(doc);
      // Create: `on conflict do nothing` (never overwrite a racing creator);
      // no row back means the race was lost, reported as a conflict for the
      // caller to re-read.
      const rows =
        expectedVersion === null
          ? await sql(
              `insert into ${TABLE} (scope, project, doc) values ($1, $2, $3::text::jsonb)
               on conflict do nothing returning version`,
              [scope, project, json],
            )
          : await sql(
              `update ${TABLE} set doc = $3::text::jsonb, version = version + 1, updated_at = now()
               where scope = $1 and project = $2 and version = $4 returning version`,
              [scope, project, json, expectedVersion],
            );
      const version = rows[0]?.version;
      if (version === undefined) throw new WorkspaceConflictError(scope, project);
      return Number(version);
    },

    async patch(scope, project, { set = {}, remove = [] }) {
      // `doc - text[]` drops keys, `||` merges — so removals apply first and
      // a key in both wins as a set. One statement, so it is atomic against
      // every other writer without holding a version: there is nothing read
      // here that a concurrent write could invalidate.
      //
      const rows = await sql(
        `update ${TABLE} set doc = (doc - $4::text[]) || $3::text::jsonb,
           version = version + 1, updated_at = now()
         where scope = $1 and project = $2 returning doc, version`,
        [scope, project, JSON.stringify(set), remove],
      );
      const row = rows[0];
      if (!row) return null;
      return { doc: row.doc, version: Number(row.version) };
    },

    async delete(scope, project) {
      await sql(`delete from ${TABLE} where scope = $1 and project = $2`, [scope, project]);
    },

    async list(scope) {
      const rows = await sql(`select project from ${TABLE} where scope = $1 order by project`, [
        scope,
      ]);
      return rows.map((row) => String(row.project));
    },
  };
}

/**
 * In-memory workspace store for local dev and tests. Same semantics as the
 * Postgres store, versions included; documents are cloned on both sides of
 * the API so callers can never share mutable state with the store (parity
 * with the jsonb round trip).
 */
export function createMemoryWorkspaceStore(): WorkspaceStore {
  const rows = new Map<string, WorkspaceRecord>();
  // `projectKey` (platform-events.ts), not a hand-rolled `${scope}/${project}`.
  // The declared spelling is NUL-separated precisely so no (scope, project)
  // pair can spell another's key, and the `/` copy here gave that up twice
  // over: the composite could collide, and `list`'s prefix scan below matched
  // every key beginning `${scope}/` — so scope `a` listed scope `a/b`'s
  // projects as its own.
  const key = projectKey;

  return {
    get(scope, project) {
      const record = rows.get(key(scope, project));
      return Promise.resolve(record ? structuredClone(record) : null);
    },

    put(scope, project, doc, expectedVersion) {
      const k = key(scope, project);
      const existing = rows.get(k);
      if (expectedVersion === null) {
        if (existing) return Promise.reject(new WorkspaceConflictError(scope, project));
        rows.set(k, { doc: structuredClone(doc), version: 1 });
        return Promise.resolve(1);
      }
      if (!existing || existing.version !== expectedVersion) {
        return Promise.reject(new WorkspaceConflictError(scope, project));
      }
      const version = existing.version + 1;
      rows.set(k, { doc: structuredClone(doc), version });
      return Promise.resolve(version);
    },

    patch(scope, project, { set = {}, remove = [] }) {
      const k = key(scope, project);
      const existing = rows.get(k);
      if (!existing) return Promise.resolve(null);
      // Removals first, then the merge — matching the SQL's `(doc - keys) ||
      // set`, so a key named in both is a set in either implementation.
      const doc = structuredClone(existing.doc) as Record<string, unknown>;
      for (const name of remove) delete doc[name];
      // Round-tripped through JSON like the jsonb bind, so an `undefined`
      // among the values disappears here exactly as it would there rather
      // than becoming a stored key with no value.
      const record = {
        doc: { ...doc, ...(JSON.parse(JSON.stringify(set)) as Record<string, unknown>) },
        version: existing.version + 1,
      };
      rows.set(k, record);
      return Promise.resolve(structuredClone(record));
    },

    delete(scope, project) {
      rows.delete(key(scope, project));
      return Promise.resolve();
    },

    list(scope) {
      // Split the composite and compare the scope EXACTLY, rather than testing
      // a prefix: a prefix scan is what let one scope see another's projects,
      // and it stays wrong-shaped even under a separator that cannot collide.
      const projects: string[] = [];
      for (const k of rows.keys()) {
        const [rowScope, project] = splitProjectKey(k);
        if (rowScope === scope) projects.push(project);
      }
      return Promise.resolve(projects.sort((a, b) => a.localeCompare(b)));
    },
  };
}
