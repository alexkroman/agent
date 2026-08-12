// Copyright 2026 the AAI authors. MIT license.

/**
 * SQL database handle available to tool `run` code when storage is
 * enabled for the app. Backed by the app's Supabase Postgres schema.
 *
 * @example
 * ```ts
 * import type { ToolContext } from "@alexkroman1/aai";
 * declare const ctx: ToolContext; // the context a tool's execute receives
 *
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
 * Max rows one `ctx.db` query may return; queries that could exceed it
 * should paginate with LIMIT/OFFSET. Exceeding the cap throws rather than
 * silently truncating — a shortened result is indistinguishable from a
 * complete one. Enforced identically under `aai dev` and on the platform
 * (both route through `createPostgresDb`).
 */
export const MAX_DB_RESULT_ROWS = 1000;

/**
 * Error thrown when tool code touches `ctx.db` while storage is not
 * enabled. Enable storage with `aai storage enable` (production) or by
 * setting `DATABASE_URL` in the project `.env` (`aai dev`). The guest
 * harness keeps an import-free duplicate of this string, pinned by an
 * equality test — dev and prod must read identically.
 */
export const STORAGE_DISABLED_MESSAGE =
  "Storage is not enabled for this app. Enable it with `aai storage enable` (CLI) or " +
  "Settings → Database in the studio; under `aai dev`, set DATABASE_URL in the " +
  "project .env.";
