// Copyright 2026 the AAI authors. MIT license.

/**
 * SQL database handle available to tool `execute` code when storage is
 * enabled for the app. Backed by the app's Supabase Postgres schema.
 *
 * @example
 * ```ts
 * await ctx.db.query("insert into notes (body) values ($1)", ["hello"]);
 * const rows = await ctx.db.query<{ body: string }>("select body from notes");
 * ```
 *
 * @public
 */
export type Db = {
  /** Run one parameterized SQL statement ($1, $2… placeholders). Resolves with the result rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};
/**
 * Max rows one `ctx.db` query may return. Enforced once, in
 * `createPostgresDb` (host/postgres-db.ts), by throwing — a silent
 * truncation is indistinguishable from a complete result — so `aai dev`
 * and the platform's `db/query` RPC (which routes through the same
 * factory) behave identically. Callers paginate with LIMIT/OFFSET.
 */
export const MAX_DB_RESULT_ROWS = 1000;

/**
 * Error thrown when tool code touches `ctx.db` while storage is not enabled.
 * Single source: the host tool-executor throws it directly; the guest harness
 * keeps an import-free duplicate in `aai-guest/limits.ts`, pinned to
 * this constant by an equality test — dev and prod must read identically.
 */
export const STORAGE_DISABLED_MESSAGE =
  "Storage is not enabled for this app. Enable it with `aai storage enable` (CLI) or " +
  "the Storage toggle in the studio; under `aai dev`, set DATABASE_URL in the " +
  "project .env.";
