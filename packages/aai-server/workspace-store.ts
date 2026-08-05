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
 * The table lives in the `aai_platform` schema, not `public`: per-app
 * tenant schemas (`app_<hex>`, see `app-database.ts`) share this database,
 * and platform-internal tables get their own namespace.
 */

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

export type WorkspaceStore = {
  /** The stored document and its version, or null when absent. */
  get(scope: string, project: string): Promise<WorkspaceRecord | null>;
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

// Deliberately NOT `public`; platform-internal tables get their own schema
// (`ensureTableOnce` creates it).
/** DDL shared with the boot-time Realtime publication setup (realtime-events.ts). */
/**
 * Postgres-backed workspace store over the platform admin connection.
 *
 * Schema + table are created lazily on first use and memoized; a failed
 * ensure resets the memo so one transient DDL error doesn't wedge the store
 * for the process lifetime. Documents are bound as JSON text with a
 * `::jsonb` cast so the statement shape is driver-agnostic; reads accept
 * either the parsed object (what the `postgres` driver returns for jsonb)
 * or a raw string.
 */
export function createPgWorkspaceStore(sql: SqlExec): WorkspaceStore {
  const parseDoc = (value: unknown): unknown =>
    typeof value === "string" ? JSON.parse(value) : value;

  return {
    async get(scope, project) {
      const rows = await sql(
        `select doc, version from ${TABLE} where scope = $1 and project = $2`,
        [scope, project],
      );
      const row = rows[0];
      if (!row) return null;
      return { doc: parseDoc(row.doc), version: Number(row.version) };
    },

    async put(scope, project, doc, expectedVersion) {
      const json = JSON.stringify(doc);
      // Create: `on conflict do nothing` (never overwrite a racing creator);
      // no row back means the race was lost, reported as a conflict for the
      // caller to re-read.
      const rows =
        expectedVersion === null
          ? await sql(
              `insert into ${TABLE} (scope, project, doc) values ($1, $2, $3::jsonb)
               on conflict do nothing returning version`,
              [scope, project, json],
            )
          : await sql(
              `update ${TABLE} set doc = $3::jsonb, version = version + 1, updated_at = now()
               where scope = $1 and project = $2 and version = $4 returning version`,
              [scope, project, json, expectedVersion],
            );
      const version = rows[0]?.version;
      if (version === undefined) throw new WorkspaceConflictError(scope, project);
      return Number(version);
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
  const key = (scope: string, project: string) => `${scope}/${project}`;

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

    delete(scope, project) {
      rows.delete(key(scope, project));
      return Promise.resolve();
    },

    list(scope) {
      const prefix = `${scope}/`;
      return Promise.resolve(
        [...rows.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length))
          .sort((a, b) => a.localeCompare(b)),
      );
    },
  };
}
